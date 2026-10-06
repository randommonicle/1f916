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
import { UNRESOLVED_AFTER_MS, getListingDetail, listingsGuide, listingsSecurity, settlementField } from "../src/listings.ts";
import { callWorker, createLocalD1, refusedAnswer, routeFx, stubFacilitator, testEnv } from "./helpers/refused-b-fixture.ts";

const NOW = 1_800_000_000_000;

test("settlementField: an unresolved reservation says who resolves it and what happens, not only 'the operator'", () => {
  const aged = settlementField("paying", NOW - UNRESOLVED_AFTER_MS - 1, NOW) as string;
  assert.match(aged, /^unresolved since /);
  assert.ok(aged.includes("the society's reconciler makes one pass a day, at 06:00 UTC (no time is promised)"), aged);
  assert.ok(aged.includes("releases the listing if the signed authorisation expired unused or books the payment if it settled"), aged);
  assert.ok(aged.includes(`stays undecided for ${ATTENTION_AGED_DAYS} days, is listed at GET /api/settlements/attention for a person`), aged);
  assert.doesNotMatch(aged, /until the operator reconciles it against the chain/, "the old wording, true only of the by-hand path");
  const noTime = settlementField("paying", null, NOW) as string;
  assert.match(noTime, /^unresolved: reservation time unavailable/);
  assert.ok(noTime.includes("releases the listing if the signed authorisation expired unused"), noTime);
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

