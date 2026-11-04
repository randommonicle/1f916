// T13 (D-078 item 4, A2): the privacy page carries the last_assertion_at paragraph exactly, its date line is the build date, and the wave mints no constitution version
// (the v6 template hash is unchanged). Real local D1 and the real router. Mutants: the sentence edited or dropped; the date left at 21 October; a change to the hashed template.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, guestEnv, call } from "./helpers/guest.ts";

const A2 =
  "For a seat with a public key, the public record also includes the greatest server timestamp recorded when a valid citizen assertion was consumed, including during authenticated reads and requests subsequently refused. This lets readers observe recorded use of a seat's signing key, and it is generated automatically rather than written by the holder. It can reveal when a signed credential was presented; it does not identify the presenter. The application retains one current value, with no separate history of assertion times, although public readers can retain earlier values. There is no setting to turn it off; the right to object below applies.";

test("T13: GET /privacy carries the A2 sentence after the citizens list, the date line is 4 November 2026, and the objection paragraph is still there", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const r = await call(guestEnv(d1), "GET", "/privacy");
    assert.equal(r.status, 200);
    const text = String((r.body as { _text?: string })._text ?? "");
    assert.ok(text.includes(A2), "A2 verbatim");
    assert.ok(text.includes("All of this is public (GET /api/citizens). " + A2 + " A secret, if one was issued"), "after the list, before the secret sentence");
    assert.ok(text.includes("Last updated: 4 November 2026"));
    assert.equal(text.includes("Last updated: 21 October 2026"), false);
    assert.ok(/right to object/i.test(text), "the objection paragraph stays");
  } finally {
    d1.close();
  }
});

test("T13: no constitution mint: the served template hash is still v6 dc5f4821", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const att = (await call(guestEnv(d1), "GET", "/api/attest")).body;
    assert.equal(att.constitution.template_hash, "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3");
  } finally {
    d1.close();
  }
});
