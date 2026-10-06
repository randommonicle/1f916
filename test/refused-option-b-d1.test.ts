// OPTION B: a first-attempt rule-7 refusal keeps the claim PENDING (docs/BRIEF-REFUSED-CHAIN-RECHECK.md, ruled by Ben 5 Oct 2026; builder commission
// drafts/BUILDER-COMMISSION-REFUSED-OPTION-B-2026-10-05.md, converged by both exchange seats 6 Oct).
//
// Until B, payAndSettle's first /settle wrote `refused` on the facilitator's word alone and answered a 402 with `accepts`, inviting a fresh signature while the signed
// authorisation (valid until validBefore) could still be mined. Now the claim stays pending with the facilitator's words, `rpc_body` intact (the expiry proof needs it), the lease let
// go; the answer is the 502 settlement_unresolved a replay of the pending row gets, plus firstRefusalDetail (the facilitator's account, why the society does not act on it alone, the
// earliest time T = validBefore + RECONCILE_EXPIRY_MARGIN_SECONDS a decision can be made); a listing_pay reservation is KEPT. Only the chain's own proof (the C6 expiry batch) turns the
// row `expired`, the one state that invites a fresh signature, and releases the listing in the same batch.
//
// Real local D1, the real Worker router for the doors that have one, the pay and create handlers called directly (as the other settlement tests do), only `fetch` stubbed.
// Run: npm test

import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  ROUTES,
  TEST_PAYER,
  TX,
  count,
  createLocalD1,
  hubRefusal,
  refusedAnswer,
  routeFx,
  stubFacilitator,
  testEnv,
  theClaim,
  type Env,
  type LocalD1,
} from "./helpers/refused-b-fixture.ts";
import {
  CHAIN_SPENT_MARKER,
  KEY_WHERE,
  SETTLEMENT_UNRESOLVED,
  acquireLease,
  claimAnswer,
  claimKeyFromPayload,
  firstRefusalDetail,
  getClaim,
  keyArgs,
  keyOfRow,
  markFirstRefusal,
  releaseLease,
  reportPointer,
  stoppedMessage,
  type ClaimKey,
  type ClaimRoute,
  type ClaimRow,
} from "../src/settlement-claims.ts";
import { RECONCILE_EXPIRY_MARGIN_SECONDS } from "../src/x402.ts";

const REQS = { network: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
const eq = (d1: LocalD1): Env => testEnv(d1);

// ---------- the write: markFirstRefusal ----------

let nonceSeq = 0xb100;
const patronSpec = { route: "patron" as const, intent: { line: "b" } };
// A claim taken by owner "A" at `takenAt` (takeClaim writes created_at = updated_at = takenAt and A's lease), as payAndSettle takes it.
async function takenClaim(d1: LocalD1, takenAt: number): Promise<ClaimKey> {
  const nonce = "0x" + (++nonceSeq).toString(16).padStart(64, "0");
  const payload = { payload: { authorization: { from: TEST_PAYER, to: "0x1", value: "1000000", validBefore: "9999999999", nonce } } };
  const { key, validBefore } = claimKeyFromPayload(payload, REQS);
  const { claimIdentity, takeClaim } = await import("../src/settlement-claims.ts");
  const id = await claimIdentity(key, validBefore, { paymentPayload: payload }, patronSpec);
  assert.deepEqual(await takeClaim(eq(d1), id, patronSpec, "A", takenAt), { taken: true });
  return key;
}
const rawRow = (d1: LocalD1, key: ClaimKey) => ({ ...(d1.raw.prepare(`SELECT * FROM settlement_claims WHERE ${KEY_WHERE}`).get(...(keyArgs(key) as never[])) as Record<string, unknown>) });

test("markFirstRefusal: the strict holder at the take time writes the facilitator's words, lets go of the lease, and leaves the state and rpc_body alone", async () => {
  const d1 = createLocalD1();
  try {
    const key = await takenClaim(d1, 5_000);
    const before = rawRow(d1, key);
    assert.equal(before.lease_owner, "A");
    assert.equal(await markFirstRefusal(eq(d1), key, hubRefusal(200, "insufficient_funds"), "A", 6_000, 5_000), true);
    const after = rawRow(d1, key);
    assert.equal(after.state, "pending", "never refused");
    assert.equal(after.verdict_reason, hubRefusal(200, "insufficient_funds"));
    assert.equal(after.rpc_body, before.rpc_body, "rpc_body is untouched: the expiry proof (attemptPending) refuses a pending row without it");
    assert.notEqual(after.rpc_body, null);
    assert.equal(after.lease_owner, null, "the lease is let go so an identical re-send can reconcile at once");
    assert.equal(after.leased_until, null);
    assert.equal(after.updated_at, 6_000, "updated_at moves: the reconciler orders by it");
    assert.equal(after.tx, null);
    assert.equal(after.booked_refs, "{}");
  } finally {
    d1.close();
  }
});

test("markFirstRefusal: the reason is clipped to 400 characters, as noteUnknown clips it", async () => {
  const d1 = createLocalD1();
  try {
    const key = await takenClaim(d1, 5_000);
    assert.equal(await markFirstRefusal(eq(d1), key, "x".repeat(900), "A", 6_000, 5_000), true);
    assert.equal(String(rawRow(d1, key).verdict_reason).length, 400);
  } finally {
    d1.close();
  }
});

test("markFirstRefusal writes NOTHING for a stale holder, a moved take time, a taken lease, a terminal or settled row, or a stopped row", async () => {
  const d1 = createLocalD1();
  try {
    // another owner: the strict holder condition (HOLDS_LEASE would also pass a NULL or lapsed lease; this write must not)
    let key = await takenClaim(d1, 5_000);
    let before = rawRow(d1, key);
    assert.equal(await markFirstRefusal(eq(d1), key, "r", "NOT-A", 6_000, 5_000), false, "wrong owner");
    assert.deepEqual(rawRow(d1, key), before);

    // the take time has moved: another holder's attempt (acquireLease sets updated_at) started since this request took the claim
    d1.raw.prepare(`UPDATE settlement_claims SET updated_at = 5_001 WHERE ${KEY_WHERE}`).run(...(keyArgs(key) as never[]));
    before = rawRow(d1, key);
    assert.equal(await markFirstRefusal(eq(d1), key, "r", "A", 6_000, 5_000), false, "updated_at is no longer the take time");
    assert.deepEqual(rawRow(d1, key), before);

    // the lapsed lease taken by B, then B's own work moved updated_at and released the lease: A's late refusal finds no lease of its own
    key = await takenClaim(d1, 5_000);
    d1.raw.prepare(`UPDATE settlement_claims SET leased_until = 1 WHERE ${KEY_WHERE}`).run(...(keyArgs(key) as never[]));
    assert.equal((await acquireLease(eq(d1), key, "B", 400_000))?.lease_owner, "B");
    before = rawRow(d1, key);
    assert.equal(await markFirstRefusal(eq(d1), key, "r", "A", 401_000, 5_000), false, "another holder took the lapsed lease");
    assert.deepEqual(rawRow(d1, key), before);
    // a holder that LET GO of its own lease (releaseLease clears lease_owner WITHOUT moving updated_at, so the take-time bound still matches) is no holder: a late refusal writes nothing
    key = await takenClaim(d1, 5_000);
    await releaseLease(eq(d1), key, "A");
    assert.equal(rawRow(d1, key).lease_owner, null);
    assert.equal(rawRow(d1, key).updated_at, 5_000, "updated_at still equals the take time, so only the strict-owner condition can refuse this write");
    before = rawRow(d1, key);
    assert.equal(await markFirstRefusal(eq(d1), key, "r", "A", 401_000, 5_000), false, "a lease that was let go is nobody's");
    assert.deepEqual(rawRow(d1, key), before);

    // every other state
    for (const state of ["settled_unbooked", "booked", "expired"] as const) {
      key = await takenClaim(d1, 5_000);
      d1.raw.prepare(`UPDATE settlement_claims SET state = ?, rpc_body = CASE WHEN ? = 'settled_unbooked' THEN rpc_body ELSE NULL END WHERE ${KEY_WHERE}`).run(state, state, ...(keyArgs(key) as never[]));
      before = rawRow(d1, key);
      assert.equal(await markFirstRefusal(eq(d1), key, "r", "A", 6_000, 5_000), false, `${state}: not pending`);
      assert.deepEqual(rawRow(d1, key), before, `${state}: untouched`);
    }

    // a STOPPED row (C4, option B) is never overwritten: the marker is the person's flag
    key = await takenClaim(d1, 5_000);
    d1.raw.prepare(`UPDATE settlement_claims SET verdict_reason = ? WHERE ${KEY_WHERE}`).run(`${CHAIN_SPENT_MARKER}the chain reads it used`, ...(keyArgs(key) as never[]));
    before = rawRow(d1, key);
    assert.equal(await markFirstRefusal(eq(d1), key, "r", "A", 6_000, 5_000), false, "stopped");
    assert.deepEqual(rawRow(d1, key), before);
  } finally {
    d1.close();
  }
});

// ---------- the answer: step 0, on every route ----------

for (const route of ROUTES) {
  test(`step 0 (${route}): a first-attempt refusal is a 502 settlement_unresolved with no accepts, the facilitator's words attributed, T = validBefore + the margin, and the nonce pointer`, async () => {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: () => refusedAnswer() });
    try {
      const fx = await routeFx(d1, route);
      const res = await fx.send();
      assert.equal(res.status, 502, JSON.stringify(res.body));
      assert.equal(res.body.code, SETTLEMENT_UNRESOLVED);
      assert.equal(res.body.accepts, undefined, "no invitation to sign again");
      assert.equal(res.body.x402Version, undefined, "not the 402 body shape either");
      const row = theClaim(d1);
      assert.equal(row.state, "pending");
      assert.notEqual(row.rpc_body, null);
      assert.equal(row.lease_owner, null);
      const text = String(res.body.error);
      // the facilitator's account, verbatim, attributed to it
      assert.ok(text.includes(hubRefusal(200, "insufficient_funds")), "the facilitator's own words, verbatim");
      assert.ok(text.includes("Do not sign again."), "and never an invitation to sign");
      assert.doesNotMatch(text, /nothing was charged/i, "it never claims nothing was charged");
      assert.doesNotMatch(text.replace("(then sign a fresh one)", ""), /sign a fresh one|sign again\b(?<!not sign again)/i, "and invites a fresh signature only conditionally, after the re-send says it expired unused");
      assert.ok(text.includes("The society does not act on that account alone: the signed authorisation stays valid until its validBefore, so this payment is not treated as refused until the chain shows the authorisation unused after "), "why the society does not act on the facilitator's word");
      // T: valid_before + 300 seconds, as an ISO UTC time, equal to what the row says
      const t = new Date((row.valid_before + 300) * 1000).toISOString();
      assert.equal(RECONCILE_EXPIRY_MARGIN_SECONDS, 300, "the margin the text is built from");
      assert.ok(text.includes(`unused after ${t}.`), `T is validBefore + 300 s (${t})`);
      // the nonce pointer: a free showhome note for the three doors a non-citizen can use, a mention of the maintainer for the funder
      if (route === "listing_pay") {
        assert.ok(text.includes(`To add your own report, mention @commonhold-agent in a comment naming this nonce (${row.nonce}) (POST /api/comment).`), "a funder is a citizen: the mention");
        assert.doesNotMatch(text, /showhome/);
      } else {
        assert.ok(text.includes(`To add your own report, leave a free showhome note naming this nonce (${row.nonce}): POST /api/showhome/enter`), "a payer may not be a citizen: the showhome");
        assert.doesNotMatch(text, /@commonhold-agent/);
      }
      assert.doesNotMatch(text, /naming this tx/, "a refused payment has no tx to name");
      // the route-specific promise, and the reconciler's tail
      if (route === "listing_pay") {
        assert.ok(text.includes("The listing stays reserved for this payment until then, and while it is reserved a re-send of this request is refused (the listing is paying, not open) before it reaches this claim, so do not re-send."));
        assert.ok(text.includes("The society's reconciler decides it on a pass after that time and, if the authorisation expired unused, releases the listing in the same step; GET /api/listing/:id serves the listing's state."));
        assert.doesNotMatch(text, /Re-send this identical request/, "a re-send of a reserved listing never reaches the claim, so it is not promised");
        assert.doesNotMatch(text, /Repeating this identical request re-checks it sooner/, "and the repeat clause is omitted exactly where it is false");
      } else {
        assert.ok(text.includes("Re-send this identical request after that time and you will be told whether it expired unused (then sign a fresh one), settled, or is still unresolved."));
        assert.ok(text.includes("Repeating this identical request re-checks it sooner."), "the repeat clause is true on this route");
      }
      assert.ok(text.includes("The society's reconciler makes one pass a day, at 06:00 UTC"), "the reconciler's backstop wording is the tail on every route");
    } finally {
      stub.restore();
      d1.close();
    }
  });
}

test("step 0 (listing_pay): the reservation is KEPT with its pinned wallet row, the settle is called once, and no payment row is written", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: () => refusedAnswer("policy") });
  try {
    const fx = await routeFx(d1, "listing_pay");
    const res = await fx.send();
    assert.equal(res.status, 502);
    const l = fx.listing!();
    assert.equal(l.status, "paying", "kept: only the claim's expiry batch releases the listing");
    assert.ok(typeof l.paying_since === "number");
    assert.ok(typeof l.paying_wallet_row_id === "number", "with the checked pair");
    assert.equal(count(d1, "listing_payments"), 0);
    assert.equal(stub.calls.settle, 1);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("step 0: the facilitator's refusal at 400, 401 and 403 is served the same way (status and reason attributed to it)", async () => {
  for (const status of [400, 401, 403]) {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: () => new Response(JSON.stringify({ success: false, errorReason: "policy" }), { status, headers: { "content-type": "application/json" } }) });
    try {
      const res = await (await routeFx(d1, "patron")).send();
      assert.equal(res.status, 502, `HTTP ${status}`);
      assert.ok(String(res.body.error).includes(hubRefusal(status, "policy")), `HTTP ${status}: the facilitator's status and reason`);
      assert.equal(theClaim(d1).state, "pending");
    } finally {
      stub.restore();
      d1.close();
    }
  }
});

// A first-attempt refusal is no refusal recorded when the write fails: the claim is re-read and answered from. A re-read that cannot be done is an unknown outcome.
test("the refusal write THREW: the lease is let go, the claim is re-read, and the answer is the pending one; a re-read that throws is an unknown outcome and pay listing KEEPS its reservation (settlement_unconfirmed)", async () => {
  const FIRST_REFUSAL_WRITE = (sql: string) => sql.replace(/\s+/g, " ").includes("AND state = 'pending' AND lease_owner = ? AND updated_at = ?");
  const CLAIM_SELECT = /^\s*SELECT \* FROM settlement_claims WHERE/;
  const boom = (): any => {
    const b: any = { bind: () => b, run: async () => { throw new Error("D1_ERROR: injected"); }, first: async () => { throw new Error("D1_ERROR: injected"); }, all: async () => { throw new Error("D1_ERROR: injected"); } };
    return b;
  };
  // (a) the write throws, nothing else fails: A answers from the re-read pending row
  {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: () => refusedAnswer() });
    const base = eq(d1);
    let armed = true;
    const env = { ...base, DB: { prepare: (sql: string) => (armed && FIRST_REFUSAL_WRITE(sql) ? ((armed = false), boom()) : base.DB.prepare(sql)), batch: (s: any[]) => base.DB.batch(s) } } as unknown as Env;
    try {
      const fx = await routeFx(d1, "listing_pay");
      const res = await fx.send(env);
      assert.equal(armed, false, "the write was attempted and failed");
      assert.equal(res.status, 502, JSON.stringify(res.body));
      assert.equal(res.body.code, SETTLEMENT_UNRESOLVED);
      assert.equal(res.body.accepts, undefined);
      assert.equal(fx.listing!().status, "paying", "the reservation is kept");
      assert.equal(theClaim(d1).lease_owner, null, "this request let go of its own lease");
      assert.doesNotMatch(String(res.body.error), /Another attempt to resolve it is in progress/, "no attempt is in progress, so none is claimed");
    } finally {
      stub.restore();
      d1.close();
    }
  }
  // (b) the write lands but the re-read throws: the outcome is unknown, so the reservation is kept and the answer is settlement_unconfirmed
  {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: () => refusedAnswer() });
    const base = eq(d1);
    let wrote = false;
    let failed = false;
    const env = {
      ...base,
      DB: {
        prepare: (sql: string) => {
          if (FIRST_REFUSAL_WRITE(sql)) {
            const real = base.DB.prepare(sql);
            return { bind: (...a: unknown[]) => { const b = real.bind(...a); return { run: async () => { const r = await b.run(); wrote = true; return r; } }; } } as any;
          }
          if (wrote && !failed && CLAIM_SELECT.test(sql)) {
            failed = true;
            return boom();
          }
          return base.DB.prepare(sql);
        },
        batch: (s: any[]) => base.DB.batch(s),
      },
    } as unknown as Env;
    try {
      const fx = await routeFx(d1, "listing_pay");
      const res = await fx.send(env);
      assert.equal(failed, true, "the re-read was attempted and failed");
      assert.equal(res.status, 502, JSON.stringify(res.body));
      assert.equal(res.body.error, "settlement_unconfirmed");
      assert.equal(fx.listing!().status, "paying", "the unknown outcome keeps the reservation");
      assert.equal(res.body.accepts, undefined);
    } finally {
      stub.restore();
      d1.close();
    }
  }
});

// ---------- the retained answers: a pre-B refused row is history, and is served as it always was ----------

test("claimAnswer still serves a legacy `refused` row as today (the facilitator's words with accepts) and a stamped one as the contradiction; a B row never reads either", () => {
  const base = { network: "base", asset: REQS.asset, from_addr: TEST_PAYER, nonce: "0x" + "9".repeat(64), route: "patron", intent_json: "{}", intent_hash: "h", rpc_body_hash: "h", valid_before: 1_000, tx: null, payer: null, booked_refs: "{}", created_at: 1, updated_at: 1, lease_owner: null, leased_until: null } as const;
  const legacy = { ...base, state: "refused", rpc_body: null, verdict_reason: hubRefusal(200, "insufficient_funds") } as ClaimRow;
  const a = claimAnswer(legacy, true, { payTo: "x" });
  assert.equal(a.status, 402);
  assert.deepEqual(a.body.accepts, [{ payTo: "x" }]);
  assert.equal(a.body.error, hubRefusal(200, "insufficient_funds"));
  const stamped = claimAnswer({ ...legacy, tx: TX, verdict_reason: `settlement_contradiction:${TX}|x` }, true, { payTo: "x" });
  assert.equal(stamped.status, 500);
  assert.equal(stamped.body.code, "settlement_contradiction");
  assert.equal(stamped.body.accepts, undefined);
  const b = claimAnswer({ ...base, state: "pending", rpc_body: "{}", verdict_reason: hubRefusal(200, "insufficient_funds") } as ClaimRow, true, { payTo: "x" }, { detail: firstRefusalDetail(hubRefusal(200, "insufficient_funds"), { route: "patron", nonce: base.nonce, valid_before: 1_000 }, 300) });
  assert.equal(b.status, 502);
  assert.equal(b.body.accepts, undefined);
});

test("firstRefusalDetail: T is valid_before + the margin passed in, as an ISO UTC time (the module imports no route module, so the caller supplies the margin)", () => {
  const row = { route: "register" as const, nonce: "0x" + "7".repeat(64), valid_before: 1_800_000_000 };
  const text = firstRefusalDetail("X.", row, 300);
  assert.ok(text.includes("unused after 2027-01-15T08:05:00.000Z."), text);
  assert.ok(firstRefusalDetail("X.", row, 0).includes("unused after 2027-01-15T08:00:00.000Z."), "the margin is the only thing added");
});

test("reportPointer is ONE function for a stopped row and a first refusal: a mention of the maintainer for a funder, a free showhome note for every other door, each naming the nonce", () => {
  const nonce = "0x" + "5".repeat(64);
  assert.equal(reportPointer({ route: "listing_pay", nonce }), `To add your own report, mention @commonhold-agent in a comment naming this nonce (${nonce}) (POST /api/comment).`);
  for (const route of ["register", "patron", "listing_create"] as const) {
    assert.equal(reportPointer({ route, nonce }), `To add your own report, leave a free showhome note naming this nonce (${nonce}): POST /api/showhome/enter (any label that is not a citizen handle), then POST /api/showhome/note.`);
  }
  const stopped = (route: ClaimRoute) => stoppedMessage({ route, nonce, intent_json: JSON.stringify({ handle: "h", listing_id: 3 }) } as unknown as ClaimRow);
  assert.ok(stopped("listing_pay").endsWith(reportPointer({ route: "listing_pay", nonce })), "the stopped message carries the shared pointer, unchanged by the refactor");
  assert.ok(stopped("patron").endsWith(reportPointer({ route: "patron", nonce })));
});

// No production path writes `refused` for a new claim (the brief: "a test that no production path calls it for a new claim"). The state stays in the type and the CHECK for rows written
// before B; this scan is what makes "nothing writes it" a build failure rather than a sentence in a comment. It reads the source text of src/ (the one place the writers live).
test("no source file writes the `refused` state (no markRefused, no SET state = 'refused'): a first-attempt refusal is written by markFirstRefusal only", () => {
  const root = new URL("../src/", import.meta.url);
  const files: string[] = [];
  const walk = (dir: URL) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(new URL(`${entry.name}/`, dir));
      else if (entry.name.endsWith(".ts")) files.push(fileURLToPath(new URL(entry.name, dir)));
    }
  };
  walk(root);
  assert.ok(files.length > 20, `the scan covered the source tree (${files.length} files)`);
  const writers: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    // the identifier, an UPDATE that sets the state to refused, or an INSERT that creates a row already in it
    if (/\bmarkRefused\b/.test(text.replace(/\/\/[^\n]*/g, ""))) writers.push(`${file}: markRefused`);
    if (/SET\s+state\s*=\s*'refused'/i.test(text)) writers.push(`${file}: SET state = 'refused'`);
    if (/state\s*=\s*"refused"[^;\n]*\bUPDATE\b|\bUPDATE\b[^;\n]*state\s*=\s*"refused"/i.test(text)) writers.push(`${file}: an UPDATE writing "refused"`);
  }
  assert.deepEqual(writers, [], "a writer of the `refused` state has come back");
});

// DEFERRED-PAY-LISTING-RESEND-REPLAY (commission Q2, both seats agreed): the flag must sit where the deferred work lands, the B4 consult in handlePayListing, which a re-send of a reserved
// listing never reaches. A grep-able flag that drifts away from its place, or is deleted, is a deferral nobody can find; this keeps it where it says it is.
test("DEFERRED-PAY-LISTING-RESEND-REPLAY is planted at the pay route's claim consult, and says why a re-send never reaches it", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/listings.ts", import.meta.url)), "utf8");
  const flag = src.indexOf("DEFERRED-PAY-LISTING-RESEND-REPLAY");
  assert.ok(flag > 0, "the flag is in src/listings.ts");
  assert.equal(src.indexOf("DEFERRED-PAY-LISTING-RESEND-REPLAY", flag + 1), -1, "once");
  const consult = src.indexOf("const replay = await replayForClaim(env, request, reqs, claim);", flag);
  assert.ok(consult > flag && consult - flag < 1500, "the consult follows the flag within the same comment block");
  const payRoute = src.indexOf("export async function handlePayListing");
  assert.ok(payRoute > 0 && payRoute < flag, "and it is inside handlePayListing, not the listing-creation door's consult (which comes first in the file)");
  const comment = src.slice(flag, consult);
  assert.match(comment, /loadPayableListing/);
  assert.match(comment, /is paying, not open/);
});
