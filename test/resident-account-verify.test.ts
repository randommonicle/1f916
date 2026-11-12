// The residency-by-account reader (src/resident-account-verify.ts; brief A6, A8, A9, B9; tests T2, T3, T8, T9, T10 at the reader). No database: the verifier takes its fetch as a
// parameter and these tests hand it the pinned fixtures (1f916 from the council's captures of 12 Oct, the Colony's from 12 Nov) with ONE named edit each. Every block names the mutant that
// turns it red; docs/CHECKPOINT-RESIDENT-ACCOUNT.md records each one run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import {
  fixtureFetch, colonyProof, f916Proof, colonyUserUrl, colonyCommentUrl, colonyUserJson, colonyCommentJson, colonyFixture, recordUrl, accountUrl, accountJson,
  COLONY_ENVOY_ID, COLONY_FIXTURE_COMMENT_ID, OUTSIDE_COLONY_ID, DAY, isoMicros, sha256Of, type Challenge, type Served,
} from "./helpers/resident-account.ts";
import { verifyResidentAccountClaim, canonicalAccountRecordId, parseColonyTime, isExcludedAccount, RESIDENT_ACCOUNT_EXCLUDED } from "../src/resident-account-verify.ts";

const NOW = Date.now();
const VISITOR = 12;
const ch = (): Challenge => ({
  nonce: "Zk3pQ9mW2xLr7TfA", claim_code: "unused", issued_at: NOW - 60_000, expires_at: NOW + 840_000, number: VISITOR, platform: "colony", purpose: "bind",
  text_to_post: `Commonhold resident account challenge Zk3pQ9mW2xLr7TfA resident ${VISITOR}`,
});
const run = (platform: "1f916" | "colony", routes: Record<string, Served | Error>, recordId: string, c = ch()) =>
  verifyResidentAccountClaim({ platform, recordId, visitorId: VISITOR, challenge: { nonce: c.nonce, issuedAt: c.issued_at }, now: NOW }, { fetch: fixtureFetch(routes) });
const CID = COLONY_FIXTURE_COMMENT_ID;

test("colony happy path: the evidence is the ids, the parsed times and the hash of each raw answer, and no comment text (mutant: the verifier stores or returns the body)", async () => {
  const c = ch();
  const routes = colonyProof(c);
  const r = await run("colony", routes, CID, c);
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) return;
  assert.equal(r.evidence.platform, "colony");
  assert.equal(r.evidence.external_account_id, OUTSIDE_COLONY_ID);
  assert.equal(r.evidence.external_handle, "outside-colonist");
  assert.equal(r.evidence.record_id, CID);
  assert.equal(r.evidence.record_sha256, sha256Of(routes[colonyCommentUrl(CID)]!.body!));
  assert.equal(r.evidence.account_sha256, sha256Of(routes[colonyUserUrl(OUTSIDE_COLONY_ID)]!.body!));
  assert.ok(Number.isInteger(r.evidence.record_created_at) && r.evidence.record_created_at > c.issued_at);
  assert.equal(r.evidence.account_created_at, Date.parse("2026-09-01T10:00:00.000Z"));
  assert.ok(!JSON.stringify(r.evidence).includes("Commonhold resident account challenge"), "no record text in the evidence");
  assert.deepEqual(Object.keys(r.evidence).sort(), ["account_created_at", "account_sha256", "external_account_id", "external_handle", "platform", "record_created_at", "record_id", "record_sha256", "retrieved_at"]);
});

test("1f916 happy path, with NO age or karma floor (mutant: the council's floors are applied to residency)", async () => {
  const c = ch();
  const r = await run("1f916", f916Proof(c, { karma: 0, ageDays: 0.001, citizenId: 4242 }), "424242", c);
  assert.equal(r.ok, true, JSON.stringify(r));
  if (r.ok) assert.equal(r.evidence.external_account_id, "4242");
});

test("T2: a record created before the challenge, or at the same instant, is refused as stale; one dated ahead of the clock is future (mutant: <= becomes <)", async () => {
  const c = ch();
  for (const [platform, routes] of [
    ["colony", colonyProof(c, { created: c.issued_at - 1 })],
    ["colony", colonyProof(c, { created: c.issued_at })],
    ["1f916", f916Proof(c, { created: c.issued_at })],
  ] as const) {
    const r = await run(platform, routes, platform === "colony" ? CID : "424242", c);
    assert.equal(r.ok === false && r.kind === "refused" && r.code, "record_stale", platform);
  }
  const future = await run("colony", colonyProof(c, { created: NOW + 10 * 60_000 }), CID, c);
  assert.equal(future.ok === false && future.kind === "refused" && future.code, "record_future");
});

test("T3: the nonce and the resident number must both be in the text, and the number must stand alone (mutant: a substring match on the number)", async () => {
  const c = ch();
  const noNonce = await run("colony", colonyProof(c, { body: `Commonhold resident account challenge WRONG resident ${VISITOR}` }), CID, c);
  assert.equal(noNonce.ok === false && noNonce.kind === "refused" && noNonce.code, "nonce_missing");
  const noNumber = await run("colony", colonyProof(c, { body: `Commonhold resident account challenge ${c.nonce}` }), CID, c);
  assert.equal(noNumber.ok === false && noNumber.kind === "refused" && noNumber.code, "visitor_missing");
  const inside = await run("colony", colonyProof(c, { body: `${c.nonce} resident 112 and 120` }), CID, c);
  assert.equal(inside.ok === false && inside.kind === "refused" && inside.code, "visitor_missing", "12 is not in 112 or 120");
  const around = await run("colony", colonyProof(c, { body: `before ${c.nonce}, resident ${VISITOR}. after` }), CID, c);
  assert.equal(around.ok, true, "words around the proof strings are allowed");
});

test("T8: the operator's own accounts are refused, by id on both platforms, and by handle (mutant: the list is empty, or the id compare is dropped)", async () => {
  const c = ch();
  const byId = await run("colony", colonyProof(c, { accountId: COLONY_ENVOY_ID, username: "renamed-envoy" }), CID, c);
  assert.equal(byId.ok === false && byId.kind === "refused" && byId.code, "operator_account");
  const byHandle = await run("colony", colonyProof(c, { username: "Commonhold-Envoy" }), CID, c);
  assert.equal(byHandle.ok === false && byHandle.kind === "refused" && byHandle.code, "operator_account");
  const f916ById = await run("1f916", f916Proof(c, { author: "renamed", citizenId: 520 }), "424242", c);
  assert.equal(f916ById.ok === false && f916ById.kind === "refused" && f916ById.code, "operator_account");
  const f916ByHandle = await run("1f916", f916Proof(c, { author: "commonhold-envoy", citizenId: 9999 }), "424242", c);
  assert.equal(f916ByHandle.ok === false && f916ByHandle.kind === "refused" && f916ByHandle.code, "operator_account");
  assert.equal(RESIDENT_ACCOUNT_EXCLUDED.length, 2, "the list names exactly the two accounts the brief names");
  assert.equal(isExcludedAccount("1f916", "521", "someone-else"), false);
  assert.equal(isExcludedAccount("colony", OUTSIDE_COLONY_ID, "someone-else"), false);
});

test("E2: an account created AFTER the proof comment cannot have written it, on both platforms (a handle re-registered between post and claim); created at the same instant is fine (mutant: the check is removed)", async () => {
  const c = ch();
  const f916 = await run("1f916", f916Proof(c, { ageDays: -1 }), "424242", c);
  assert.equal(f916.ok === false && f916.kind === "refused" && f916.code, "account_newer_than_record");
  const colony = await run("colony", colonyProof(c, { userOver: { created_at: isoMicros(NOW + 30_000) } }), CID, c);
  assert.equal(colony.ok === false && colony.kind === "refused" && colony.code, "account_newer_than_record");
  // equal instants: the 1f916 account is created exactly when the comment is
  const routes = f916Proof(c, {});
  const recordAt = c.issued_at + 1;
  routes[accountUrl("outside-f916")] = { body: accountJson({ handle: "outside-f916", citizen_id: 777, karma: 0, created_at: recordAt }) };
  assert.equal((await run("1f916", routes, "424242", c)).ok, true, "same instant passes");
  const later = f916Proof(c, {});
  later[accountUrl("outside-f916")] = { body: accountJson({ handle: "outside-f916", citizen_id: 777, karma: 0, created_at: recordAt + 1 }) };
  const one = await run("1f916", later, "424242", c);
  assert.equal(one.ok === false && one.kind === "refused" && one.code, "account_newer_than_record", "one millisecond later is refused");
});

test("T9: a held Colony comment, and an account the Colony does not mark as an agent, are refused (mutant: held or user_type is not read)", async () => {
  const c = ch();
  const held = await run("colony", colonyProof(c, { held: true }), CID, c);
  assert.equal(held.ok === false && held.kind === "refused" && held.code, "record_held");
  const human = await run("colony", colonyProof(c, { userType: "human" }), CID, c);
  assert.equal(human.ok === false && human.kind === "refused" && human.code, "not_an_agent");
  // the comment's embedded author says agent but the account read says human: the two must agree, or it is drift, not a verdict
  const split = colonyProof(c);
  split[colonyUserUrl(OUTSIDE_COLONY_ID)] = { body: colonyUserJson({ id: OUTSIDE_COLONY_ID, username: "outside-colonist", user_type: "human", created_at: "2026-09-01T10:00:00.000000Z" }) };
  const r = await run("colony", split, CID, c);
  assert.equal(r.ok === false && r.kind === "unreadable" && r.code, "shape_changed");
});

test("B9: the comment and the account must agree on id and username, and times parse strictly (mutant: the cross-check is dropped, or a bad time is read as 0)", async () => {
  const c = ch();
  const idSplit = colonyProof(c);
  idSplit[colonyUserUrl(OUTSIDE_COLONY_ID)] = { body: colonyUserJson({ id: "6b0c1f2e-7a44-4c1e-9d0a-0f3b2c6a8e11", username: "outside-colonist", user_type: "agent", created_at: "2026-09-01T10:00:00.000000Z" }) };
  const a = await run("colony", idSplit, CID, c);
  assert.equal(a.ok === false && a.kind === "unreadable" && a.code, "shape_changed");
  const nameSplit = colonyProof(c, { userOver: { username: "someone-else" } });
  const b = await run("colony", nameSplit, CID, c);
  assert.equal(b.ok === false && b.kind === "unreadable" && b.code, "shape_changed");
  for (const bad of [1791792532203, "2026-11-12 12:53:25", "not a date", "2026-13-45T99:99:99Z", null]) {
    const r = await run("colony", colonyProof(c, { commentOver: { created_at: bad } as any }), CID, c);
    assert.equal(r.ok === false && r.kind === "unreadable" && r.code, "shape_changed", `created_at ${JSON.stringify(bad)}`);
  }
  assert.equal(parseColonyTime("2026-11-12T12:53:25.600501Z"), Date.parse("2026-11-12T12:53:25.600Z"));
  assert.equal(parseColonyTime("2026-11-12T12:53:25Z"), Date.parse("2026-11-12T12:53:25Z"));
  assert.equal(parseColonyTime(5), null);
});

test("B9: a Colony UUID is canonicalised to lower case before any fetch, and anything else is refused before a fetch (mutant: the canonicaliser accepts a non-UUID)", () => {
  assert.equal(canonicalAccountRecordId("colony", CID.toUpperCase()), CID);
  assert.equal(canonicalAccountRecordId("colony", ` ${CID} `), CID);
  for (const bad of ["12345", "../users/x", `${CID}/x`, "", null, 7, "14533981-e43a-4cda-9934-8360f51ecf2"]) assert.equal(canonicalAccountRecordId("colony", bad), null, String(bad));
  assert.equal(canonicalAccountRecordId("1f916", 102669), "102669");
  assert.equal(canonicalAccountRecordId("1f916", CID), null);
  assert.equal(canonicalAccountRecordId("1f3d9", "5"), null);
});

test("the pinned absent shapes: a Colony 404 in the pinned shape is a refusal; a 404 in another shape is drift (mutant: any 404 is a verdict)", async () => {
  const c = ch();
  const ok404 = await run("colony", { [colonyCommentUrl(CID)]: { status: 404, body: colonyFixture("comment-missing.json") } }, CID, c);
  assert.equal(ok404.ok === false && ok404.kind === "refused" && ok404.code, "record_missing");
  const drift = await run("colony", { [colonyCommentUrl(CID)]: { status: 404, body: JSON.stringify({ message: "gone" }) } }, CID, c);
  assert.equal(drift.ok === false && drift.kind === "unreadable" && drift.code, "shape_changed");
  const noUser = colonyProof(c);
  noUser[colonyUserUrl(OUTSIDE_COLONY_ID)] = { status: 404, body: colonyFixture("user-missing.json") };
  const m = await run("colony", noUser, CID, c);
  assert.equal(m.ok === false && m.kind === "refused" && m.code, "account_missing");
  const f404 = await run("1f916", { [recordUrl(5)]: { status: 404, body: JSON.stringify({ error: "no comment" }) } }, "5", c);
  assert.equal(f404.ok === false && f404.kind === "refused" && f404.code, "record_missing");
});

test("T10: unreachable, 429 and 5xx are retryable; a redirect, a non-JSON body and a shape change are not; none is a refusal (mutant: a 5xx is mapped to a refusal)", async () => {
  const c = ch();
  const cases: Array<[string, Record<string, Served | Error>, boolean | null, string]> = [
    ["network error", { [colonyCommentUrl(CID)]: new Error("connection reset") }, true, "fetch_failed"],
    ["429", { [colonyCommentUrl(CID)]: { status: 429, body: "{}" } }, true, "not_ok"],
    ["503", { [colonyCommentUrl(CID)]: { status: 503, body: "{}" } }, true, "not_ok"],
    ["500 on the account read", { ...colonyProof(c), [colonyUserUrl(OUTSIDE_COLONY_ID)]: { status: 500, body: "{}" } }, true, "not_ok"],
    ["redirect", { [colonyCommentUrl(CID)]: { status: 302, headers: { location: "https://elsewhere.example/" }, body: "" } }, false, "redirect"],
    ["html", { [colonyCommentUrl(CID)]: { body: "<html></html>" } }, false, "not_json"],
    ["400", { [colonyCommentUrl(CID)]: { status: 400, body: "{}" } }, false, "not_ok"],
    ["shape", { [colonyCommentUrl(CID)]: { body: JSON.stringify({ id: CID }) } }, false, "shape_changed"],
  ];
  for (const [name, routes, retryable, code] of cases) {
    const r = await run("colony", routes, CID, c);
    assert.ok(!r.ok && r.kind === "unreadable", name);
    if (!r.ok && r.kind === "unreadable") {
      assert.equal(r.retryable, retryable, name);
      assert.equal(r.code, code, name);
    }
  }
  const f = await run("1f916", { [recordUrl(5)]: { status: 503, body: "{}" } }, "5", c);
  assert.ok(!f.ok && f.kind === "unreadable" && f.retryable);
});

test("the Colony reader asks for the lower-cased author id and never follows a redirect (mutant: the user read uses the raw id)", async () => {
  const c = ch();
  const routes = colonyProof(c, { accountId: OUTSIDE_COLONY_ID.toUpperCase() });
  routes[colonyUserUrl(OUTSIDE_COLONY_ID)] = routes[colonyUserUrl(OUTSIDE_COLONY_ID.toUpperCase())]!;
  const calls: Array<{ url: string }> = [];
  const r = await verifyResidentAccountClaim(
    { platform: "colony", recordId: CID, visitorId: VISITOR, challenge: { nonce: c.nonce, issuedAt: c.issued_at }, now: NOW },
    {
      fetch: async (url, init) => {
        calls.push({ url });
        assert.equal(init.redirect, "manual");
        const hit = routes[url];
        if (!hit) throw new Error(`unexpected outbound URL: ${url}`);
        return new Response(hit.body ?? "", { status: hit.status ?? 200 });
      },
    },
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(calls.map((x) => x.url), [colonyCommentUrl(CID), colonyUserUrl(OUTSIDE_COLONY_ID)]);
  if (r.ok) assert.equal(r.evidence.external_account_id, OUTSIDE_COLONY_ID, "stored lower-case");
  assert.ok(isoMicros(NOW).endsWith("123Z"));
  assert.ok(DAY > 0 && accountUrl("x").startsWith("https://1f916.ai/") && accountJson({}).length > 0 && colonyCommentJson({}).length > 0);
});
