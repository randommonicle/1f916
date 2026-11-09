// T13 (D-078 item 4, A2): the privacy page carries the last_assertion_at paragraph exactly, its date line is the build date, and the wave mints no constitution version
// (the v6 template hash is unchanged). Real local D1 and the real router. Mutants: the sentence edited or dropped; the date left at 21 October; a change to the hashed template.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, guestEnv, call } from "./helpers/guest.ts";

const A2 =
  "For a seat with a public key, the public record also includes the UTC day of the latest server time recorded when a valid citizen assertion was consumed, including during authenticated reads and requests subsequently refused. This lets readers observe recorded use of a seat's signing key, and it is generated automatically rather than written by the holder. It can reveal the day on which a signed credential was presented, and someone polling can see roughly when the value changes, normally no more than once a day. The separate last_me_at field starts at registration time and is updated to the time of an authenticated me call, and a key rotation's public record shows its time. It does not by itself identify the presenter, but it may be linked to a person through other public information. The application retains one current value, with no separate history of assertion times, although public readers can retain earlier values. There is no self-service setting. If the holder of a seat's key objects and shows it holds that key, the operator clears the stored value and records no more for that seat. The census then shows null, as it does for a seat with no recorded use, and no objection marker is published, though a reader who saved an earlier value can see that it has gone. A later written record beside a null can also suggest an objection. The operator keeps the time of the objection and a private record of the request and its outcome. The seat can still act, and its written records and last_me_at are unaffected. Copies public readers already took cannot be recalled. Any other objection, including from a person to whom the time relates or a holder who has lost the key, is assessed individually.";

test("T13: GET /privacy carries the A2 sentence after the citizens list, the date line is 9 November 2026, and the objection paragraph is still there", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const r = await call(guestEnv(d1), "GET", "/privacy");
    assert.equal(r.status, 200);
    const text = String((r.body as { _text?: string })._text ?? "");
    assert.ok(text.includes(A2), "A2 verbatim");
    assert.ok(text.includes("All of this is public (GET /api/citizens). " + A2 + " A secret, if one was issued"), "after the list, before the secret sentence");
    assert.ok(text.includes("Last updated: 9 November 2026"));
    assert.equal(text.includes("Last updated: 21 October 2026"), false);
    assert.ok(/right to object/i.test(text), "the objection paragraph stays");
    // Gate M1 (proposed wording, pending Ben's ruling): the lawful-basis paragraph names the key-use time.
    assert.ok(text.includes("checking council-seat claims against another platform, recording and publishing the day a citizen seat's signing key last authenticated, and keeping attested records."), "legitimate-interests list");
    assert.ok(text.includes("A seat's key-use day is different: it is generated automatically rather than chosen by the holder. The application database holds one current value, by itself it shows use of a key and not who used it, and the holder can object, which stops it, as described under Citizens above. It is published because a seat's key can be used here without the seat writing anything, and no other public field covers that use across every route. This field publishes only the day, because the time of day is not needed for that. It shows that a valid assertion signed by the key was consumed on that day, and not that the key still works."), "the balancing sentence");
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
