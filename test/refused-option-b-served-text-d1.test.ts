// OPTION B, the served-text sweep (L-002 class: a string a server response carries is a claim about what the server does; docs/BRIEF-REFUSED-CHAIN-RECHECK.md, commission item 5).
//
// What changed: a recorded facilitator refusal on a payment's first /settle no longer answers a 402 and no longer releases a listing_pay reservation; the claim stays pending, the
// listing stays reserved, and only the claim's expiry proof (the society's reconciler, or the payer's re-send on the three doors where it reaches the claim) releases it. So the one
// served sentence that described how a reserved listing ends ("until the operator reconciles it against the chain") now said too little about the common case; and every surface that
// tells a payer what a refusal means had to be checked. This file pins the changed sentence and scans the served surfaces for the old claims.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { ATTENTION_AGED_DAYS } from "../src/settlement-attention.ts";
import { CHAIN_SPENT_MARKER, claimAnswer, type ClaimRow } from "../src/settlement-claims.ts";
import { UNRESOLVED_AFTER_MS, getListingDetail, listingsGuide, listingsSecurity, settlementField } from "../src/listings.ts";
import { TX, callWorker, chainRpc, createLocalD1, refusedAnswer, routeFx, settledAnswer, stubFacilitator, testEnv } from "./helpers/refused-b-fixture.ts";

const NOW = 1_800_000_000_000;

test("settlementField: an unresolved reservation says who resolves it and what happens, not only 'the operator'", () => {
  const aged = settlementField("paying", NOW - UNRESOLVED_AFTER_MS - 1, NOW) as string;
  assert.match(aged, /^unresolved since /);
  assert.ok(aged.includes("the society's reconciler makes one pass a day, at 06:00 UTC (no time is promised)"), aged);
  assert.ok(aged.includes("releases the listing if the signed authorisation expired unused or books the payment if it settled"), aged);
  assert.ok(aged.includes(`stays undecided for ${ATTENTION_AGED_DAYS} days, is listed at GET /api/settlements/attention for a person`), aged);
  assert.doesNotMatch(aged, /until the operator reconciles it against the chain/, "the old wording, true only of the by-hand path");
  // A row with no reservation time pre-dates migration 0014, which pre-dates the claim table (0017): it has NO claim, so the reconciler can never select, release or book it and the attention
  // list never carries it. The reconciler's sentence would be a promise the code cannot keep there, so that arm keeps the by-hand wording.
  const noTime = settlementField("paying", null, NOW) as string;
  assert.match(noTime, /^unresolved: reservation time unavailable/);
  assert.ok(noTime.endsWith("neither open nor paid until the operator reconciles it against the chain"), noTime);
  assert.doesNotMatch(noTime, /reconciler|06:00|attention/, "no promise the code cannot keep for a claimless row");
  const young = settlementField("paying", NOW - 1000, NOW) as string;
  assert.match(young, /^pending since /);
  assert.equal(settlementField("open", null, NOW), undefined);
  assert.equal(settlementField("paid", null, NOW), undefined);
});

test("the listing a refused funder is pointed to (GET /api/listing/:id) serves the reservation and its explanation", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: () => refusedAnswer() });
  try {
    const fx = await routeFx(d1, "listing_pay");
    const res = await fx.send();
    assert.equal(res.status, 502);
    const id = (d1.raw.prepare("SELECT id FROM listings").get() as { id: number }).id;
    assert.ok(String(res.body.error).includes("GET /api/listing/:id serves the listing's state."), "the answer points the funder there");
    const detail = await getListingDetail(testEnv(d1), id);
    assert.equal(detail.listing.status, "paying");
    assert.match(String(detail.listing.settlement), /^pending since /, "right after the refusal it reads as pending, with the pair that was checked");
    // later, with the reservation aged past the x402 window plus the margin, it reads as unresolved and names the reconciler
    d1.raw.prepare("UPDATE listings SET paying_since = ? WHERE id = ?").run(Date.now() - UNRESOLVED_AFTER_MS - 60_000, id);
    const later = await getListingDetail(testEnv(d1), id);
    assert.match(String(later.listing.settlement), /^unresolved since /);
    assert.ok(String(later.listing.settlement).includes("the society's reconciler makes one pass a day"));
  } finally {
    stub.restore();
    d1.close();
  }
});

// A scan of every served surface that could tell a payer what a refused settlement means: none may say a refused settlement is answered with a 402, or releases a listing, or that a
// funder can pay again straight after one. (Before option B that was true of the code and of nothing served; the scan keeps it from being claimed now that it is false.)
const SERVED = ["/", "/llms.txt", "/skill.md", "/heartbeat.md", "/api/surface", "/api/listings/guide", "/api/listings/security", "/api/official", "/api/listings"];
// Read per SENTENCE (a sentence is a run up to a full stop, a semicolon or a line break), each claim being three word-groups that must all be present in it.
const OLD_CLAIMS: { name: string; all: RegExp[] }[] = [
  { name: "a failed or refused settlement is answered 402", all: [/refus|fail/i, /settl|facilitator/i, /\b402\b/] },
  { name: "a refused settlement releases the listing or the reservation", all: [/refus|fail/i, /settl|facilitator|payment/i, /releas|re-?open/i] },
  { name: "the facilitator's refusal is final or means no money moved", all: [/facilitator/i, /refus|fail/i, /no money moved|\bfinal\b|terminal/i] },
];

function scanServed(texts: Record<string, string>): string[] {
  const hits: string[] = [];
  for (const [where, text] of Object.entries(texts)) {
    for (const sentence of text.split(/(?<=[.;!?])\s+|\n|\n/)) {
      for (const c of OLD_CLAIMS) if (c.all.every((re) => re.test(sentence))) hits.push(`${where}: ${c.name}: "${sentence.trim().slice(0, 200)}"`);
    }
  }
  return hits;
}

async function servedTexts(): Promise<Record<string, string>> {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const out: Record<string, string> = {};
    for (const path of SERVED) out[path] = await (await callWorker(new Request(`https://example.test${path}`), env)).text();
    return out;
  } finally {
    d1.close();
  }
}

test("no served surface claims a refused settlement is answered 402, releases a listing, or means no money moved (the scan reads / /llms.txt /skill.md /heartbeat.md /api/surface the listings guide, security, official and the listings read)", async () => {
  const texts = await servedTexts();
  assert.ok(Object.values(texts).every((t) => t.length > 100), "every surface was read, none empty");
  assert.deepEqual(scanServed(texts), []);
  // the structured guide and security objects are the same text the routes serve; scanned here as values too
  assert.deepEqual(scanServed({ guide: JSON.stringify(listingsGuide()), security: JSON.stringify(listingsSecurity()) }), []);
});

test("the scan can fail: it fires on each of the old claims and stays silent on the sentences the surfaces really carry", () => {
  const guilty = [
    "If the facilitator refuses the settlement the server answers 402 and invites a fresh signature.",
    "A refused payment releases the listing back to open at once.",
    "When the facilitator reports the settlement failed, no money moved: that is final.",
  ];
  for (const g of guilty) assert.ok(scanServed({ x: g }).length > 0, `the scan misses: ${g}`);
  const innocent = [
    "A pin that is stale is refused before any payment, and a refusal writes nothing public.",
    "The first request returns 402 with signed-payment requirements; pay with any x402 client and retry with the X-PAYMENT header.",
    "unresolved = reserved for payment and never confirmed settled, ten minutes on",
  ];
  for (const s of innocent) assert.deepEqual(scanServed({ x: s }), [], `the scan fires on a true sentence: ${s}`);
});

// ---------- the first-refusal answer carries a machine-readable discriminator, and no other answer does (build review F2, CODEX) ----------
//
// `settlement_unresolved` is a code several answers share: the first-attempt facilitator refusal kept pending (option B), a re-send's answer on a pending row, a settled-but-unbooked claim, a
// claim stopped for a person, and a success the facilitator reported that this request could not record (a held success naming the tx). A client that reads the code alone cannot tell the
// first from the last, and the last means the money may have moved. The B answer ALONE carries `facilitator_refused: true` and `recheck_after` (T, ISO UTC); status 502 and the code are unchanged.

const DISCRIMINATOR = ["facilitator_refused", "recheck_after"] as const;
const carriesNone = (body: Record<string, unknown>): boolean => DISCRIMINATOR.every((k) => !(k in body));

for (const route of ["register", "patron", "listing_create", "listing_pay"] as const) {
  test(`discriminator (${route}): the first-attempt refusal answer says facilitator_refused: true and recheck_after = validBefore + the margin; status and code are unchanged`, async () => {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: () => refusedAnswer() });
    try {
      const res = await (await routeFx(d1, route)).send();
      assert.equal(res.status, 502);
      assert.equal(res.body.code, "settlement_unresolved", "unchanged, so existing clients are unaffected");
      assert.equal(res.body.facilitator_refused, true);
      const validBefore = (d1.raw.prepare("SELECT valid_before FROM settlement_claims").get() as { valid_before: number }).valid_before;
      assert.equal(res.body.recheck_after, new Date((validBefore + 300) * 1000).toISOString());
      assert.ok(String(res.body.error).includes(`unused after ${res.body.recheck_after}.`), "the field and the sentence name the same time");
    } finally {
      stub.restore();
      d1.close();
    }
  });
}

test("discriminator: no other settlement_unresolved answer carries it (a re-send on the pending row, a settled-but-unbooked claim, a stopped claim, an unknown first outcome, a held success)", async () => {
  // a re-send on the refused row, before validBefore: the attempt re-POSTs, is refused again, and answers from the pending row with the attempt's detail
  {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: () => refusedAnswer(), rpc: chainRpc(false) });
    try {
      const fx = await routeFx(d1, "patron");
      assert.equal((await fx.send()).body.facilitator_refused, true);
      const resend = await fx.send();
      assert.equal(resend.status, 502);
      assert.equal(resend.body.code, "settlement_unresolved");
      assert.ok(carriesNone(resend.body), "a re-send's answer is not the first refusal's answer: " + JSON.stringify(Object.keys(resend.body)));
    } finally {
      stub.restore();
      d1.close();
    }
  }
  // stopped for a person: the chain reads the authorisation used while the facilitator refuses again
  {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: () => refusedAnswer(), rpc: chainRpc(true) });
    try {
      const fx = await routeFx(d1, "patron");
      await fx.send();
      const stopped = await fx.send();
      assert.equal(stopped.status, 500);
      assert.equal(stopped.body.code, "settlement_unresolved");
      assert.ok(carriesNone(stopped.body));
    } finally {
      stub.restore();
      d1.close();
    }
  }
  // settled but unbooked: the payment settled and the booking failed
  {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: () => settledAnswer() });
    try {
      d1.raw.exec("CREATE TRIGGER breaks_ledger BEFORE INSERT ON ledger BEGIN SELECT RAISE(ABORT, 'injected booking failure'); END;");
      const res = await (await routeFx(d1, "patron")).send();
      assert.equal(res.status, 500);
      assert.ok(carriesNone(res.body));
    } finally {
      stub.restore();
      d1.close();
    }
  }
  // an unknown first outcome (settlement_pending): the facilitator did not say refused
  {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: () => new Response(JSON.stringify({ success: false, errorReason: "settlement_pending" }), { status: 200, headers: { "content-type": "application/json" } }) });
    try {
      const res = await (await routeFx(d1, "patron")).send();
      assert.equal(res.status, 502);
      assert.ok(carriesNone(res.body));
    } finally {
      stub.restore();
      d1.close();
    }
  }
  // a held success (the facilitator reported a settlement this request could not record), and the pending/lease-held answers: claimAnswer itself, which builds every one of them
  const pending = { network: "base", asset: "0x1", from_addr: "0x2", nonce: "0x" + "3".repeat(64), route: "patron", intent_json: "{}", intent_hash: "h", rpc_body: "{}", rpc_body_hash: "h", valid_before: 1_800_000_000, state: "pending", tx: null, payer: null, verdict_reason: null, booked_refs: "{}", created_at: 1, updated_at: 1, lease_owner: null, leased_until: null } as unknown as ClaimRow;
  for (const [label, opts] of [
    ["a held success naming the tx", { settledTx: TX }],
    ["a held success with an empty tx", { settledTx: "" }],
    ["another attempt in progress", { leaseHeld: true }],
    ["a re-send's detail", { detail: "x" }],
    ["no options", {}],
  ] as const) {
    const a = claimAnswer(pending, true, {}, opts);
    assert.ok(carriesNone(a.body), `${label}: no discriminator`);
  }
  assert.ok(carriesNone(claimAnswer({ ...pending, state: "settled_unbooked", tx: TX } as ClaimRow, true, {}).body), "a settled-but-unbooked claim's answer");
  const first = claimAnswer(pending, true, {}, { detail: "x", firstRefusalRecheckAfter: "2027-01-15T08:05:00.000Z" });
  assert.equal(first.body.facilitator_refused, true);
  assert.equal(first.body.recheck_after, "2027-01-15T08:05:00.000Z");
  assert.equal(first.body.code, "settlement_unresolved");
  assert.equal(first.status, 502);
  // a stopped row is answered with its own words even if the option is passed (the option never turns a person-must-look answer into the refusal story)
  const stopped = claimAnswer({ ...pending, verdict_reason: `${CHAIN_SPENT_MARKER}the chain reads it used` } as ClaimRow, true, {}, { firstRefusalRecheckAfter: "2027-01-15T08:05:00.000Z" });
  assert.ok(carriesNone(stopped.body));
  assert.equal(stopped.status, 500);
});
