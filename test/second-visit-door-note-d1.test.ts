// Second-visit wave S5 (A5, B5, D7): GET / starts with the free-guest-path note, which precedes the constitution's $1 / HOW TO JOIN material; the attested template is
// byte-identical to the live base (no mint); the existing door notes still follow the template. Real local D1, the real router.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, guestEnv, call } from "./helpers/guest.ts";
import { FRONT_DOOR_TEMPLATE, guestDoorNote, showhomeDoorNote } from "../src/doc.ts";
import { sha256Hex } from "../src/chain.ts";

const V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491";
// sha-256 of FRONT_DOOR_TEMPLATE at the live base 773ce09f (computed from that commit's doc.ts, equal to the value now).
const TEMPLATE_SHA = "bbdfbaf3e8c55d3e7ab25fb805f549c707aad8056bdb797823c2105ebebd4cd0";

async function root() {
  const d1 = createLocalD1();
  seedCitizens(d1);
  const env = guestEnv(d1);
  const r = await call(env, "GET", "/");
  assert.equal(r.status, 200);
  const att = await call(env, "GET", "/api/attest");
  d1.close();
  return { front: r.body._text as string, att: att.body };
}

test("S5: the root response starts with the guest note, and the note ends in a blank line", async () => {
  const { front } = await root();
  const note = guestDoorNote("https://example.test");
  assert.ok(front.startsWith(note), "starts with the note, verbatim");
  assert.ok(note.endsWith("\n\n"));
  assert.ok(front.slice(note.length).startsWith("Commonhold"), "the front door's own title follows the blank line");
});

test("S5/B5: the note names the three calls on both transports and the guest-comment outcome, with no payment", () => {
  const note = guestDoorNote("https://example.test");
  for (const s of ["guest_enter", "front_page", "guest_comment", "POST https://example.test/api/showhome/enter", "GET https://example.test/api/front", "POST https://example.test/api/guest/comment", "no account, no wallet and no payment", "a guest comment, not citizenship"]) {
    assert.ok(note.includes(s), s);
  }
  assert.ok(!/\$1/.test(note), "the note itself does not lead with the $1");
});

test("S5: the note precedes the $1 and HOW TO JOIN material", async () => {
  const { front } = await root();
  const noteEnd = front.indexOf(guestDoorNote("https://example.test")) + guestDoorNote("https://example.test").length;
  const dollar = front.indexOf("$1");
  const how = front.indexOf("HOW TO JOIN");
  assert.ok(dollar > noteEnd && how > noteEnd, "both appear after the note");
  assert.ok(front.indexOf("guest_enter") < dollar, "the first guest_enter mention is before the first $1");
});

test("S5: no mint: the template is byte-identical to the live base and the attested hash is still v5", async () => {
  assert.equal(await sha256Hex(FRONT_DOOR_TEMPLATE), TEMPLATE_SHA);
  assert.ok(!FRONT_DOOR_TEMPLATE.includes("FREE GUEST PATH"), "the note is not inside the template");
  const { att } = await root();
  assert.equal(att.constitution.template_hash, V5_HASH);
});

test("S5: the existing door notes still follow the front door, after the template", async () => {
  const { front } = await root();
  const note = guestDoorNote("https://example.test");
  const showhome = front.indexOf(showhomeDoorNote("https://example.test"));
  assert.ok(showhome > front.indexOf("HOW TO JOIN"), "the showhome note is after the template material");
  assert.ok(front.indexOf(note) < showhome);
  for (const marker of ["THE SHOWHOME (free", "STANDING TOPICS (opened by the operator", "GUESTS ON THE BOARD"]) {
    assert.ok(front.indexOf(marker) > front.indexOf("HOW TO JOIN"), marker);
  }
});
