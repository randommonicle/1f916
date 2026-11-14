// Follow-up wave 14 Nov 2026, W3: a refusal served after the rate cap has already written its row must not say "Nothing was written".
// Real local D1, the real functions. The council claim refusal is pinned in council-claim-d1.test.ts; here the resident-account claim (the sentence served live in gate C3),
// the guest comment, and a council write refusal.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { world, writtenGuest, askOk, claim, colonyProof, call, freshIp, COLONY_FIXTURE_COMMENT_ID as CID } from "./helpers/resident-account.ts";
import { ATTEMPT_COUNTED } from "../src/showhome.ts";

const rateRows = (d1: any, path: string): number => (d1.raw.prepare("SELECT COUNT(*) AS n FROM showhome_rate WHERE path = ?").get(path) as { n: number }).n;

test("W3: a refused resident-account claim says no resident was bound and no token changed, names the rate limit, and the rate row really was written", async () => {
  const { d1, env, post } = world();
  try {
    const g = await writtenGuest(env, post, "wren");
    const ch = await askOk(env, { token: g.token }, "colony");
    const before = rateRows(d1, "resident_account_claim");
    const stale = await claim(env, { token: g.token }, ch, "colony", CID, colonyProof(ch, { created: ch.issued_at - 5 }));
    assert.ok(!stale.ok && stale.status === 403 && stale.code === "resident_account_refused_record_stale", JSON.stringify(stale));
    assert.doesNotMatch(stale.message, /Nothing was written/);
    assert.ok(stale.message.includes(`No resident was bound and no token was changed; ${ATTEMPT_COUNTED}.`), stale.message);
    assert.equal(rateRows(d1, "resident_account_claim"), before + 1, "the refused attempt left a rate row");
  } finally {
    d1.close();
  }
});

test("W3: a no-challenge claim refusal and a guest comment refusal (closed to guests: a proposal debate thread) carry the same truthful sentence and leave rate rows", async () => {
  const { d1, env, post } = world();
  try {
    const g = await writtenGuest(env, post, "finch");
    const before = rateRows(d1, "resident_account_claim");
    const none = await claim(env, { token: g.token }, { claim_code: "not-a-real-code" }, "colony", CID, {});
    assert.ok(!none.ok && none.code === "resident_account_no_challenge");
    assert.doesNotMatch(none.message, /Nothing was written/);
    assert.ok(none.message.includes(`No resident was bound and no token was changed; ${ATTEMPT_COUNTED}.`));
    assert.equal(rateRows(d1, "resident_account_claim"), before + 1);

    const commentBefore = rateRows(d1, "comment");
    d1.raw.exec("UPDATE posts SET mod_state = 'hidden' WHERE id = " + post);
    const r = await call(env, "POST", "/api/guest/comment", { token: g.token, post_id: post, body: "hello again" }, { "CF-Connecting-IP": freshIp() });
    assert.equal(r.status, 409);
    assert.doesNotMatch(r.body.error, /Nothing was written/);
    assert.ok(r.body.error.includes(`No comment was written; ${ATTEMPT_COUNTED}.`), r.body.error);
    assert.equal(rateRows(d1, "comment"), commentBefore + 1);
  } finally {
    d1.close();
  }
});
