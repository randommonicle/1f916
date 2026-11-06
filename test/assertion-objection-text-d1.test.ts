// The served text of an upheld objection (D-078 item 4 option B; brief O9, AO2, AO4; OT9). Literal strings, not the constants they render from, over the BUILT surfaces: the
// privacy page, GET /api/citizens' note, /llms.txt, /api/surface and tools/list on both MCP doors. No constitution mint. Each block names its mutant;
// docs/CHECKPOINT-LAST-ASSERTION-AT.md records each run.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, guestEnv, call } from "./helpers/guest.ts";
import { handleMcp } from "../src/mcp.ts";
import { handleMcpRead } from "../src/mcp-read.ts";
import type { Env } from "../src/society.ts";

const flat = (s: string) => s.replace(/\s+/g, " ");
const NULL_NOTE =
  "Null means a secret-held seat (which has no signature to record), no recorded assertion, or an objection the operator has upheld; these are not distinguished, and null is not evidence the seat is inert.";
const OLD_CLAUSE = "null on a row with a public_key means none recorded";
const THREE = "null for a secret-held seat, none recorded, or an upheld objection, which are not distinguished; the response note defines it";

async function tools(handler: typeof handleMcp, env: Env): Promise<any[]> {
  const res = await handler(new Request("https://example.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), env);
  return ((await res.json()) as any).result.tools;
}
const textOf = async (env: Env, path: string) => {
  const r = await call(env, "GET", path);
  return flat(typeof (r.body as any)?._text === "string" ? (r.body as any)._text : JSON.stringify(r.body));
};

test("OT9: the privacy page carries the AO4 citizens wording, the lawful-basis edits and the 6 November date (mutant: any one edited back)", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const t = flat(await textOf(guestEnv(d1), "/privacy"));
    for (const s of [
      "It does not by itself identify the presenter, but it may be linked to a person through other public information.",
      "There is no self-service setting. If the holder of a seat's key objects and shows it holds that key, the operator clears the stored value and records no more for that seat.",
      "The census then shows null, as it does for a seat with no recorded use, and no objection marker is published, though a reader who saved an earlier value can see that it has gone.",
      "The operator keeps the time of the objection and a private record of the request and its outcome.",
      "The seat can still act, and its written records and last_me_at are unaffected. Copies public readers already took cannot be recalled.",
      "Any other objection, including from a person to whom the time relates or a holder who has lost the key, is assessed individually.",
      "recording and publishing the day a citizen seat's signing key last authenticated",
      "The application database holds one current value, by itself it shows use of a key and not who used it, and the holder can object, which stops it, as described under Citizens above. It is published because a seat's key can be used here without the seat writing anything, and no other public field covers that use across every route. This field publishes only the day, because the time of day is not needed for that. It shows that a valid assertion signed by the key was consumed on that day, and not that the key still works.",
      "Last updated: 6 November 2026",
      "A later written record beside a null can also suggest an objection.",
      "A nonce record holds the seat, or for a resident the visitor number, and an expiry time; a council challenge record holds the visitor number and its issue, expiry and use times.",
      "The operator's private record of an objection to a seat's key-use day, and of its outcome: six years after the objection ends.",
    ]) assert.ok(t.includes(s), s);
    assert.equal(t.includes("it does not identify the presenter."), false, "the old sentence is gone");
    assert.equal(t.includes("There is no setting to turn it off"), false);
    assert.equal(t.includes("Last updated: 4 November 2026"), false);
  } finally {
    d1.close();
  }
});

test("OT9: GET /api/citizens' note says all three meanings of null and no longer carries the old clause (mutant: the clause is appended beside the old one, or the sentence is dropped)", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const note = flat(String((await call(guestEnv(d1), "GET", "/api/citizens")).body.note));
    assert.ok(note.includes(NULL_NOTE));
    assert.equal(note.toLowerCase().includes(OLD_CLAUSE), false, "REPLACED, not appended beside");
    assert.ok(note.includes("after migrations 0024 and 0025"));
  } finally {
    d1.close();
  }
});

test("OT9 (AO2): the route note, llms.txt and the citizens tool description on BOTH doors name the third null meaning (mutant: any one surface reverted)", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const env = guestEnv(d1);
    const surface = await textOf(env, "/api/surface");
    assert.ok(surface.includes(THREE), "/api/surface route note");
    const llms = await textOf(env, "/llms.txt");
    assert.ok(llms.includes("when an objection has been upheld, which are not distinguished"), "/llms.txt");
    for (const [name, h] of [["/mcp", handleMcp], ["/mcp/read", handleMcpRead as unknown as typeof handleMcp]] as const) {
      const t = (await tools(h, env)).find((x) => x.name === "citizens");
      assert.ok(t, name);
      assert.ok(flat(t.description).includes(THREE), `${name} citizens description`);
    }
    for (const s of [surface, llms]) assert.equal(s.includes("null for a secret-held seat or none recorded"), false);
  } finally {
    d1.close();
  }
});
