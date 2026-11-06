// The serving side of citizens.last_assertion_at (D-078 item 4; drafts/BRIEF-LAST-ASSERTION-AT-2026-11-04.md B4, A1, A2, A7; T9, T10, T13). Real local D1, the real router and
// both real MCP doors. The note text is pinned here as a literal copy of the brief's A1, so an edit to the served constant alone goes red. Each block names its mutant;
// docs/CHECKPOINT-LAST-ASSERTION-AT.md records each run.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, guestEnv, call } from "./helpers/guest.ts";
import { seedKeyCitizen, seedSecretCitizen, citizenAssertion, withClock } from "./helpers/council.ts";
import { authenticate, utcMidnight } from "../src/society.ts";

const A1 =
  "last_assertion_at is the start of the UTC day, in milliseconds, of the latest server time recorded for a citizen assertion from this seat whose signature verified against the seat's key at that moment and whose nonce was spent. This field keeps only the day, not the time of day. While recording is on, authentication sets the value when it is null and otherwise advances it only when the server samples a later UTC day than the stored one, normally on the seat's first assertion of a new day, so someone polling can see roughly when that assertion happened. last_me_at and a key_rotation row still show their own times. The server samples the time during authentication, just before verifying the signature, so it is not the signer's clock. Authenticated reads count, and a later refusal by the route or tool does not undo it; a request rejected before the nonce is spent does not count. /mcp/read authenticates nothing and never moves it. Null means a secret-held seat (which has no signature to record), no recorded assertion, or an objection the operator has upheld; these are not distinguished, and null is not evidence the seat is inert. Recording starts when the worker implementing this field serves, after migrations 0024 and 0025, on or after 4 November 2026; earlier signatures were never kept and a worker rolled back to an older version records nothing, so a null or an old value says nothing about those periods. A key rotation does not clear it: compare it, to the day, with the seat's key_rotation rows on GET /api/events?kind=key_rotation. A recorded assertion shows the corresponding private key signed it; it does not show who presented it, or that it is the same agent as before. It is our record, in our database and in no hash chain, and it enters no figure the society divides by.";
const T0 = 1_800_000_000_000;
const row = (body: any, handle: string) => body.citizens.find((c: { handle: string }) => c.handle === handle);

async function door(env: any, path: string): Promise<any> {
  const r = await call(env, "POST", path, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "citizens", arguments: {} } }, { "CF-Connecting-IP": "203.0.113.9" });
  assert.equal(r.status, 200, path);
  return JSON.parse(r.body.result.content[0].text);
}

test("T9: last_assertion_at is on every row of the HTTP list and both MCP doors, null before any assertion, and the doors serve the same rows (mutant: the column is dropped from the SELECT)", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const env = guestEnv(d1);
    const k = await seedKeyCitizen(d1, "keyed-a");
    const s = await seedSecretCitizen(d1, "bearer-a");
    const before = await call(env, "GET", "/api/citizens");
    assert.equal(before.status, 200);
    for (const c of before.body.citizens) {
      assert.ok("last_assertion_at" in c, `${c.handle} carries the key`);
      assert.equal(c.last_assertion_at, null);
    }
    await withClock(T0, async () => authenticate(env, await citizenAssertion(k)));
    const rest = await call(env, "GET", "/api/citizens");
    assert.equal(row(rest.body, "keyed-a").last_assertion_at, utcMidnight(T0));
    assert.equal(row(rest.body, "bearer-a").last_assertion_at, null);
    assert.ok(s.id > 0);
    for (const p of ["/mcp", "/mcp/read"]) assert.deepEqual(await door(env, p), rest.body, `${p} serves what REST serves`);
  } finally {
    d1.close();
  }
});

test("T9: the field is on /api/citizens only: not in /api/official, not in /api/council (mutant: the field is added to the composition or the council members)", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const env = guestEnv(d1);
    const k = await seedKeyCitizen(d1, "keyed-a");
    await withClock(T0, async () => authenticate(env, await citizenAssertion(k)));
    for (const path of ["/api/official", "/api/council"]) {
      const r = await call(env, "GET", path);
      assert.equal(r.status, 200, path);
      assert.equal(JSON.stringify(r.body).includes("last_assertion_at"), false, `${path} does not carry the field`);
    }
  } finally {
    d1.close();
  }
});

test("T9: the served note carries the A1 text exactly and points last_me_at at the new field (mutant: any word of the constant changes)", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const rest = await call(guestEnv(d1), "GET", "/api/citizens");
    const note = rest.body.note as string;
    assert.ok(note.includes(A1), "the note carries A1 verbatim");
    assert.ok(note.endsWith(A1), "and ends with it");
    assert.ok(note.includes("is not a signature time (see last_assertion_at)"));
    assert.equal(note.includes("  "), false, "no double spaces were introduced at the join");
  } finally {
    d1.close();
  }
});

test("T10: a stamp enters no figure: composition, acts, last_write_at and last_me_at are identical before and after a stamp on a seat that never wrote (mutant: the stamp moves last_seen_at or a count)", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const env = guestEnv(d1);
    const k = await seedKeyCitizen(d1, "keyed-a");
    const comp = async () => JSON.stringify((await call(env, "GET", "/api/official")).body.composition);
    const before = await call(env, "GET", "/api/citizens");
    const compBefore = await comp();
    await withClock(T0, async () => authenticate(env, await citizenAssertion(k)));
    const after = await call(env, "GET", "/api/citizens");
    assert.equal(await comp(), compBefore, "composition unchanged by a stamp");
    const b = row(before.body, "keyed-a");
    const a = row(after.body, "keyed-a");
    assert.notEqual(a.last_assertion_at, b.last_assertion_at, "the stamp did move");
    for (const f of ["acts", "last_write_at", "last_me_at"]) assert.deepEqual(a[f], b[f], `${f} unchanged by a non-me assertion`);
    const { last_assertion_at: _x, ...aRest } = a;
    const { last_assertion_at: _y, ...bRest } = b;
    assert.deepEqual(aRest, bRest, "no other field of the row moved");
  } finally {
    d1.close();
  }
});
