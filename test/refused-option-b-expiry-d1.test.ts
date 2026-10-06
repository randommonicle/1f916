// OPTION B, how a first-attempt refusal ENDS (docs/BRIEF-REFUSED-CHAIN-RECHECK.md; commission drafts/BUILDER-COMMISSION-REFUSED-OPTION-B-2026-10-05.md).
//
// test/refused-option-b-d1.test.ts pins what a first-attempt refusal is (a pending claim, the 502 answer). This file pins the ways it ends, on the real router, the real handlers and the
// real reconciler, with only `fetch` stubbed: the chain's own proof (C6) turns it `expired`, and ONLY then does anything invite a fresh signature; a listing_pay reservation is released only
// in that batch; the chain reading the authorisation used books it (the facilitator's cached success) or stops it for a person; a secret-mode registration still waits for its payer's
// identical re-send; and the reconciler takes money that moved ahead of refusals.
//
// "Time passes" is modelled as production sees it: the claim's valid_before column is in the past (the stored authorisation's window closed), and the RPC stub answers blocks stamped
// with the (real) current time, which is past validBefore + the margin. A trailing RPC is a block stamped earlier.
//
// Run: npm test

import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  ROUTES,
  TX,
  callWorker,
  captureLog,
  chainRpc,
  count,
  createLocalD1,
  eventLines,
  refusedAnswer,
  routeFx,
  settledAnswer,
  stubFacilitator,
  testEnv,
  theClaim,
  type Env,
  type LocalD1,
  type RouteFx,
} from "./helpers/refused-b-fixture.ts";
import { ATTENTION_AGED_DAYS } from "../src/settlement-attention.ts";
import { CHAIN_SPENT_MARKER, SETTLEMENT_UNRESOLVED, acquireLease, keyOfRow, type ClaimRoute, type ClaimRow } from "../src/settlement-claims.ts";
import { RECONCILE_BATCH_ROWS, RECONCILE_ROW_WORST_CASE, RECONCILE_SUBREQUEST_CEILING, runReconciler } from "../src/settlement-reconcile.ts";

const eq = (d1: LocalD1): Env => testEnv(d1);
const NOW_S = () => Math.floor(Date.now() / 1000);
const DAY_MS = 86_400_000;

// The window of the stored authorisation has closed `agoSeconds` ago (the claim's own column, which attemptPending reads).
const timePasses = (d1: LocalD1, agoSeconds = 10_000) => d1.raw.prepare("UPDATE settlement_claims SET valid_before = ?").run(NOW_S() - agoSeconds);
const state = (d1: LocalD1) => theClaim(d1).state;

// A first-attempt refusal on `route`, then (optionally) the facilitator and chain dials for what follows.
interface World {
  settle: (n: number) => Response;
  used: () => boolean;
  blockTime: () => number;
}
function worldStub(world: Partial<World> & { settle?: World["settle"] } = {}) {
  const w: World = { settle: (n) => (n === 1 ? refusedAnswer() : refusedAnswer()), used: () => false, blockTime: () => NOW_S(), ...world };
  return stubFacilitator({ settle: (n) => w.settle(n), rpc: (url, n, init) => chainRpc(() => w.used(), () => w.blockTime())(url, n, init) });
}

// ---------- the expiry proof ends it: the payer's identical re-send (register, patron, listing_create) ----------

for (const route of ["register", "patron", "listing_create"] as ClaimRoute[]) {
  test(`expiry (${route}): after T at the chain's clock the identical re-send marks the claim expired and ONLY THEN invites a fresh signature; nothing is re-POSTed`, async () => {
    const d1 = createLocalD1();
    const stub = worldStub();
    try {
      const fx = await routeFx(d1, route);
      const first = await fx.send();
      assert.equal(first.status, 502);
      assert.equal(first.body.accepts, undefined);
      assert.equal(stub.calls.settle, 1);
      timePasses(d1);
      const resend = await fx.send();
      assert.equal(resend.status, 402, JSON.stringify(resend.body));
      assert.ok(Array.isArray(resend.body.accepts) && resend.body.accepts.length === 1, "an EXPIRED claim invites the fresh signature, with the chain's proof behind it");
      assert.match(String(resend.body.error), /expired unused: the chain shows its nonce was never spent/);
      const row = theClaim(d1);
      assert.equal(row.state, "expired");
      assert.equal(row.rpc_body, null, "the body is cleared with the terminal state");
      assert.equal(stub.calls.settle, 1, "the expiry proof re-POSTs nothing");
      // and a further re-send is the same answer from the terminal row, with no further chain reads
      const rpcBefore = stub.rpcUrls.length;
      const again = await fx.send();
      assert.equal(again.status, 402);
      assert.equal(stub.rpcUrls.length, rpcBefore, "a terminal row is answered from the row");
    } finally {
      stub.restore();
      d1.close();
    }
  });

  test(`expiry (${route}): NOT after the wall clock alone, nor while the chain's blocks trail: no accepts, still pending, and the answer says why`, async () => {
    const d1 = createLocalD1();
    let trail = false;
    const stub = worldStub({ blockTime: () => (trail ? NOW_S() - 10_000 - 500 : NOW_S()) });
    try {
      const fx = await routeFx(d1, route);
      assert.equal((await fx.send()).status, 502);
      // (a) validBefore has passed, but T (validBefore + 300) has not: the society waits out the margin
      d1.raw.prepare("UPDATE settlement_claims SET valid_before = ?").run(NOW_S() - 100);
      const early = await fx.send();
      assert.equal(early.status, 502, JSON.stringify(early.body));
      assert.equal(early.body.accepts, undefined);
      assert.match(String(early.body.error), /past its validBefore and unused so far; the society waits out a margin before calling it expired/);
      assert.equal(state(d1), "pending");
      // (b) the wall clock says T has passed, but the chain's own clock (the RPCs' latest blocks) trails: no quorum, no decision
      timePasses(d1);
      trail = true;
      const trailing = await fx.send();
      assert.equal(trailing.status, 502, JSON.stringify(trailing.body));
      assert.equal(trailing.body.accepts, undefined);
      assert.match(String(trailing.body.error), /the chain's own clock has not confirmed it/);
      assert.equal(state(d1), "pending", "the Worker's clock alone never decides `expired`");
      // (c) the chain catches up: now it is decided
      trail = false;
      const done = await fx.send();
      assert.equal(done.status, 402);
      assert.equal(state(d1), "expired");
    } finally {
      stub.restore();
      d1.close();
    }
  });
}

// ---------- the expiry proof ends it: the reconciler (all four routes), and a listing_pay reservation goes only in that batch ----------

for (const route of ROUTES) {
  test(`expiry (${route}): the 06:00 reconciler pass after T resolves the claim as expired${route === "listing_pay" ? ", releasing the listing in the SAME batch and not before" : ""}`, async () => {
    const d1 = createLocalD1();
    const stub = worldStub();
    try {
      const fx = await routeFx(d1, route);
      assert.equal((await fx.send()).status, 502);
      if (fx.listing) assert.equal(fx.listing().status, "paying", "the reservation stands until the claim's expiry batch");
      // before T the reconciler decides nothing (it re-POSTs, is refused again, and notes it)
      const before = await runReconciler(eq(d1));
      assert.equal(before.resolved, 0, JSON.stringify(before));
      assert.equal(state(d1), "pending");
      if (fx.listing) assert.equal(fx.listing().status, "paying", "still reserved: nothing proves the authorisation dead yet");
      // T passes
      timePasses(d1);
      d1.raw.prepare("UPDATE settlement_claims SET updated_at = 1").run();
      const out = await runReconciler(eq(d1));
      assert.equal(out.resolved, 1, JSON.stringify(out));
      const row = theClaim(d1);
      assert.equal(row.state, "expired");
      assert.equal(row.rpc_body, null);
      assert.equal(row.lease_owner, null);
      if (fx.listing) {
        const l = fx.listing();
        assert.equal(l.status, "open", "released by the same batch that expired the claim");
        assert.equal(l.paying_since, null);
        assert.equal(l.paying_wallet_row_id, null, "and the pinned pair goes with it");
      }
      // the cost of that row stays inside the reconciler's own budget (unchanged by option B)
      assert.equal(RECONCILE_ROW_WORST_CASE, 18);
      assert.equal(RECONCILE_SUBREQUEST_CEILING, 26);
      assert.ok(out.actualCost <= 1 + 15, `an expiry row is at most lease 1 + 4 + 8 + a terminal write of 2 = 15, plus the select (${out.actualCost})`);
    } finally {
      stub.restore();
      d1.close();
    }
  });
}

test("expiry (listing_pay): an identical re-send of the refused request is refused by the reservation BEFORE it reaches the claim (the 'paying, not open' 409), so nothing is re-POSTed and the claim stays pending", async () => {
  const d1 = createLocalD1();
  const stub = worldStub();
  try {
    const fx = await routeFx(d1, "listing_pay");
    assert.equal((await fx.send()).status, 502);
    timePasses(d1);
    const resend = await fx.send();
    assert.equal(resend.status, 409, JSON.stringify(resend.body));
    assert.match(String(resend.body.error), /is paying, not open/, "the step-0 text told the funder not to re-send for this reason");
    assert.equal(state(d1), "pending", "a re-send cannot trigger the expiry proof on this route: only the reconciler resolves it");
    assert.equal(fx.listing!().status, "paying");
    assert.equal(stub.calls.settle, 1);
    // ...and the reconciler does, after which a FRESH signature can be taken
    d1.raw.prepare("UPDATE settlement_claims SET updated_at = 1").run();
    assert.equal((await runReconciler(eq(d1))).resolved, 1);
    assert.equal(fx.listing!().status, "open");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- the chain reads the authorisation USED: booked, or stopped for a person, never refused or expired ----------

test("cancellation: the chain reads the authorisation USED (the signer cancelled it) and the facilitator refuses again: the claim is STOPPED for a person, never refused and never expired; no accepts", async () => {
  const d1 = createLocalD1();
  const stub = worldStub({ used: () => true });
  try {
    const fx = await routeFx(d1, "patron");
    assert.equal((await fx.send()).status, 502);
    const resend = await fx.send();
    assert.equal(resend.status, 500, JSON.stringify(resend.body));
    assert.equal(resend.body.code, SETTLEMENT_UNRESOLVED);
    assert.equal(resend.body.accepts, undefined);
    assert.match(String(resend.body.error), /used \(spent, or cancelled by its signer\), so the money may have moved/);
    assert.match(String(resend.body.error), /Do not sign again/);
    const row = theClaim(d1);
    assert.equal(row.state, "pending", "stopped, not terminal");
    assert.ok(String(row.verdict_reason).startsWith(CHAIN_SPENT_MARKER), "stamped with the stopped marker");
    // it stays stopped: a further re-send and the reconciler touch nothing
    const settleBefore = stub.calls.settle;
    const rpcBefore = stub.rpcUrls.length;
    assert.equal((await fx.send()).status, 500);
    const out = await runReconciler(eq(d1));
    assert.equal(out.examined, 0, "the SELECT excludes a stopped row");
    assert.equal(stub.calls.settle, settleBefore);
    assert.equal(stub.rpcUrls.length, rpcBefore);
    // and a person is told, on the attention list, under its own marker
    const res = await callWorker(new Request("https://example.test/api/settlements/attention"), eq(d1));
    const body = (await res.json()) as { entries: { marker: string; state: string }[] };
    assert.deepEqual(body.entries.map((e) => `${e.state}:${e.marker}`), ["pending:chain_spent_facilitator_refused"]);
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- a settlement after the refusal: booked once (register, patron, listing_create by the re-send; listing_pay by the reconciler only) ----------

for (const route of ["register", "patron", "listing_create"] as ClaimRoute[]) {
  test(`success after a first-attempt refusal (${route}): the identical re-send reads the chain, re-POSTs, is told settled and BOOKS it, once`, async () => {
    const d1 = createLocalD1();
    const stub = worldStub({ settle: (n) => (n === 1 ? refusedAnswer() : settledAnswer()) });
    try {
      const fx = await routeFx(d1, route);
      assert.equal((await fx.send()).status, 502);
      assert.equal(state(d1), "pending");
      const resend = await fx.send();
      assert.equal(resend.status, route === "register" ? 201 : route === "listing_create" ? 201 : 200, JSON.stringify(resend.body));
      assert.equal(theClaim(d1).state, "booked");
      assert.equal(theClaim(d1).tx, TX);
      assert.equal(stub.calls.settle, 2, "one refused settle, one re-POST");
      if (route === "register") {
        assert.equal(count(d1, "citizens"), 1);
        assert.equal(count(d1, "ledger"), 1);
      } else if (route === "patron") {
        assert.equal(count(d1, "ledger"), 1);
      } else {
        assert.equal(count(d1, "listings"), 1);
        assert.equal(count(d1, "ledger"), 1);
      }
      // a third send is the booked 409 and books nothing more
      const third = await fx.send();
      assert.equal(third.status, 409);
      assert.equal(third.body.code, "settlement_already_booked");
      assert.equal(count(d1, "ledger"), 1);
    } finally {
      stub.restore();
      d1.close();
    }
  });
}

test("success after a first-attempt refusal (listing_pay): the re-send never reaches the claim (the reservation answers it), the reconciler's re-POST settles and books it, once", async () => {
  const d1 = createLocalD1();
  const stub = worldStub({ settle: (n) => (n === 1 ? refusedAnswer() : settledAnswer()) });
  try {
    const fx = await routeFx(d1, "listing_pay");
    assert.equal((await fx.send()).status, 502);
    const resend = await fx.send();
    assert.equal(resend.status, 409, "the funder's re-send meets the reservation first");
    assert.equal(stub.calls.settle, 1, "so it re-POSTs nothing");
    const out = await runReconciler(eq(d1));
    assert.equal(out.booked, 1, JSON.stringify(out));
    assert.equal(theClaim(d1).state, "booked");
    assert.equal(fx.listing!().status, "paid");
    assert.equal(count(d1, "listing_payments"), 1, "one payment row");
    assert.equal(stub.calls.settle, 2);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("secret-mode registration after a first-attempt refusal: the reconciler's re-POST settles it but never books it (its secret leaves only in the payer's own 201); the payer's identical re-send does, and delivers the secret", async () => {
  const d1 = createLocalD1();
  const stub = worldStub({ settle: (n) => (n === 1 ? refusedAnswer() : settledAnswer()) });
  try {
    const fx = await routeFx(d1, "register", { secretMode: true });
    assert.equal((await fx.send()).status, 502);
    const out = await runReconciler(eq(d1));
    assert.equal(out.booked, 0, JSON.stringify(out));
    assert.equal(theClaim(d1).state, "settled_unbooked", "settled, and waiting for the payer");
    assert.equal(count(d1, "citizens"), 0, "no seat yet: nobody has the secret");
    // the reconciler does not select it again (its SELECT excludes a secret-mode settled_unbooked row)
    const second = await runReconciler(eq(d1));
    assert.equal(second.examined, 0);
    const resend = await fx.send();
    assert.equal(resend.status, 201, JSON.stringify(resend.body));
    assert.equal(typeof resend.body.secret, "string", "the secret is delivered in the response to the payer's own re-send");
    assert.equal(theClaim(d1).state, "booked");
    assert.equal(count(d1, "citizens"), 1);
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- a held success meeting a first-attempt-refusal row is a pending row's, not a terminal one's ----------

test("a re-send's re-POST reads SUCCESS while another holder holds the pending first-refusal claim: the success is held (logged, named), the claim stays pending, no accepts", async () => {
  const d1 = createLocalD1();
  let bTakes = false;
  const stub = worldStub({
    settle: (n) => {
      if (n === 1) return refusedAnswer();
      bTakes = true;
      return settledAnswer();
    },
  });
  try {
    const fx = await routeFx(d1, "patron");
    assert.equal((await fx.send()).status, 502);
    // the re-send's lease lapses inside its re-POST and a second holder takes it: modelled at the D1 binding, as the lease tests do, by taking the lease when the re-POST is asked
    const base = eq(d1);

    const env = {
      ...base,
      DB: {
        prepare: (sql: string) => {
          const stmt = base.DB.prepare(sql);
          if (!/SET state = 'settled_unbooked'/.test(sql)) return stmt;
          return {
            bind: (...a: unknown[]) => {
              const b = stmt.bind(...a);
              return {
                run: async () => {
                  // B holds a LIVE lease when the re-send's markSettled runs, so it writes nothing
                  d1.raw.prepare("UPDATE settlement_claims SET leased_until = 1").run();
                  const row = d1.raw.prepare("SELECT * FROM settlement_claims").get() as ClaimRow;
                  await acquireLease(base, keyOfRow(row), "B", Date.now());
                  return b.run();
                },
              };
            },
          } as any;
        },
        batch: (s: any[]) => base.DB.batch(s),
      },
    } as unknown as Env;
    const { value: res, lines } = await captureLog(() => fx.send(env));
    assert.equal(bTakes, true, "the re-send reached its re-POST");
    assert.equal(res.status, 502, JSON.stringify(res.body));
    assert.equal(res.body.accepts, undefined);
    assert.equal(res.body.code, SETTLEMENT_UNRESOLVED);
    assert.ok(String(res.body.error).includes(TX), "the answer names the tx the facilitator reported");
    assert.match(String(res.body.error), /Do not sign again/);
    assert.equal(eventLines(lines, "settlement_success_unrecorded").length, 1, "and the success is logged once, for a person");
    assert.equal(theClaim(d1).state, "pending", "pending, not terminal: it books when B finishes, or is found by the next pass");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- the attention list ----------

test("attention: an old first-attempt-refusal row is listed as pending_aged, and that marker's text already says the facilitator's answer was not acted on", async () => {
  const d1 = createLocalD1();
  const stub = worldStub();
  try {
    const fx = await routeFx(d1, "patron");
    assert.equal((await fx.send()).status, 502);
    const res0 = await callWorker(new Request("https://example.test/api/settlements/attention"), eq(d1));
    assert.equal(((await res0.json()) as { count: number }).count, 0, "a young pending row is not listed");
    d1.raw.prepare("UPDATE settlement_claims SET created_at = ?, updated_at = ?").run(Date.now() - ATTENTION_AGED_DAYS * DAY_MS - 60_000, Date.now() - ATTENTION_AGED_DAYS * DAY_MS - 60_000);
    const res = await callWorker(new Request("https://example.test/api/settlements/attention"), eq(d1));
    const body = (await res.json()) as { entries: { marker: string; state: string }[]; markers: Record<string, string> };
    assert.deepEqual(body.entries.map((e) => `${e.state}:${e.marker}`), ["pending:pending_aged"]);
    assert.match(body.markers.pending_aged, /the facilitator's answer was unknown or not acted on, or the claim is waiting for the chain to show its authorisation used or expired/);
    assert.ok(!JSON.stringify(body).includes("insufficient_funds"), "and the facilitator's words are not served on the list");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- the reconciler takes money that moved ahead of refusals ----------

test("starvation: refusals older than a settled-but-unbooked payment cannot take both of the reconciler's two daily slots; the booking goes first", async () => {
  const d1 = createLocalD1();
  const stub = worldStub({ settle: (n) => (n === 4 ? settledAnswer() : refusedAnswer()) });
  try {
    // three first-attempt refusals (patron: no throttle, the cheapest for a stranger to produce)
    const refused: RouteFx[] = [];
    for (let i = 0; i < 3; i++) {
      const fx = await routeFx(d1, "patron");
      assert.equal((await fx.send()).status, 502);
      refused.push(fx);
    }
    assert.equal(count(d1, "settlement_claims WHERE state = 'pending'"), 3);
    // a payment that SETTLED and whose booking then failed (a ledger write that fails once), so it is settled_unbooked
    d1.raw.exec("CREATE TRIGGER fail_one_ledger BEFORE INSERT ON ledger BEGIN SELECT RAISE(ABORT, 'injected booking failure'); END;");
    const paid = await routeFx(d1, "patron");
    const failed = await paid.send();
    assert.equal(failed.status, 500, JSON.stringify(failed.body));
    d1.raw.exec("DROP TRIGGER fail_one_ledger");
    const settledRow = d1.raw.prepare("SELECT nonce FROM settlement_claims WHERE state = 'settled_unbooked'").get() as { nonce: string };
    assert.ok(settledRow, "one claim is settled_unbooked");
    // the refusals are OLDER than the settled claim by attempt time (oldest-first alone would take the first two of them and leave the booking waiting)
    const old = Date.now() - 5 * DAY_MS;
    let i = 0;
    for (const r of d1.raw.prepare("SELECT nonce FROM settlement_claims WHERE state = 'pending' ORDER BY created_at").all() as { nonce: string }[]) {
      d1.raw.prepare("UPDATE settlement_claims SET updated_at = ?, created_at = ? WHERE nonce = ?").run(old + i++, old + i, r.nonce);
    }
    assert.equal(RECONCILE_BATCH_ROWS, 2);
    const out = await runReconciler(eq(d1));
    assert.equal(out.booked, 1, `the settled payment is booked on this pass: ${JSON.stringify(out)}`);
    assert.equal(count(d1, "settlement_claims WHERE state = 'booked'"), 1);
    assert.equal(count(d1, "ledger"), 1, "booked once");
    assert.ok(out.examined >= 1);
  } finally {
    stub.restore();
    d1.close();
  }
});


// DEFERRED-RECONCILE-SLOT-SPLIT: the trade the ordering makes (a settled_unbooked row that keeps failing is tried first every run, so TWO would starve every pending row, a first-attempt
// refusal included) is named where the SELECT is, and this keeps the flag there.
test("DEFERRED-RECONCILE-SLOT-SPLIT is planted above the reconciler's SELECT and names the two-failing-rows residual", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/settlement-reconcile.ts", import.meta.url)), "utf8");
  const flag = src.indexOf("DEFERRED-RECONCILE-SLOT-SPLIT");
  assert.ok(flag > 0);
  assert.equal(src.indexOf("DEFERRED-RECONCILE-SLOT-SPLIT", flag + 1), -1, "once");
  const select = src.indexOf("ORDER BY CASE state WHEN 'settled_unbooked' THEN 0 ELSE 1 END");
  assert.ok(select > flag && select - flag < 1200, "the flag sits in the comment block directly above the SELECT it qualifies");
  assert.match(src.slice(flag, select), /TWO such rows would take both slots every run and starve every pending row/);
});
