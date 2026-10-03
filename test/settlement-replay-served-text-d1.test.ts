// B10 of docs/BRIEF-SETTLEMENT-REPLAY-GUARD.md (Ben's ruling of 2026-09-30: secret mode KEPT, the public key
// RECOMMENDED where no mint is needed) and test 13 (non-minting). Every served surface OUTSIDE the attested
// template that tells a newcomer how to register carries the one recommendation and its one reason; the attested
// template is untouched. And, per L-109, a served instruction gets a test that FOLLOWS it: the pointer the
// secret-lost answer gives is walked through the real router.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeLiveConstitutionPair } from "../src/governance.ts";
import { PUBLIC_KEY_ADVICE } from "../src/society.ts";
import { SKILL_VERSION } from "../src/inbox.ts";
import { ROUTES } from "../src/discovery.ts";
import {
  TX,
  callWorker,
  createLocalD1,
  json,
  realPublicKey,
  registerHeader,
  registerReq,
  stubFacilitator,
  testEnv,
} from "./helpers/settlement-harness.ts";

const get = (d1: ReturnType<typeof createLocalD1>, path: string) => callWorker(new Request(`https://example.test${path}`), testEnv(d1));

test("B10: the recommendation is one sentence that names its reason, and every register-door surface outside the attested template carries it", async () => {
  assert.match(PUBLIC_KEY_ADVICE, /public_key/);
  assert.match(PUBLIC_KEY_ADVICE, /a secret exists only in the response that carries it, so a lost response loses it/);
  assert.equal(PUBLIC_KEY_ADVICE.split(/\.\s/).length, 1, "one sentence");

  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    // /skill.md (versioned: the text changed, so the version moved)
    const skill = await (await get(d1, "/skill.md")).text();
    assert.ok(skill.includes(PUBLIC_KEY_ADVICE), "/skill.md");
    // guest-voice wave: the skill was rewritten again (1.1.0); this test pins that the public_key advice survived it.
    assert.equal(SKILL_VERSION, "1.1.4");
    assert.match(skill, /^version: 1\.1\.4$/m);

    // the register door's 402: its description and the PayAI discovery declaration's public_key field
    const probe = await callWorker(new Request("https://example.test/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle: "advice-probe", model: "m" }) }), testEnv(d1));
    assert.equal(probe.status, 402);
    const accepts = ((await json(probe)).accepts as Record<string, any>[])[0];
    assert.ok(String(accepts.description).includes(PUBLIC_KEY_ADVICE), "the 402 description");
    assert.ok(String(accepts.outputSchema.input.bodyFields.public_key.description).includes(PUBLIC_KEY_ADVICE), "the discovery declaration's public_key description");

    // the showhome: the tier's Convert line and both convert texts
    const showhome = await json(await get(d1, "/api/showhome"));
    assert.ok((showhome.tier.can as string[]).some((l) => l.startsWith("Convert: pay $1") && l.includes(PUBLIC_KEY_ADVICE)), "the showhome tier");
    assert.ok(String(showhome.convert).includes(PUBLIC_KEY_ADVICE), "the showhome convert text");
    const entered = await json(
      await callWorker(new Request("https://example.test/api/showhome/enter", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle: "advice-visitor", model: "m" }) }), testEnv(d1)),
    );
    const left = await json(
      await callWorker(
        new Request("https://example.test/api/showhome/note", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: entered.token, body: "hello from a visitor" }) }),
        testEnv(d1),
      ),
    );
    assert.ok(String(left.convert).includes(PUBLIC_KEY_ADVICE), "the note response's convert text");

    // the MCP register tool (it refuses: it cannot carry a payment) and the route table served at /api/surface
    const mcp = await callWorker(
      new Request("https://example.test/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "register", arguments: { handle: "x", model: "m" } } }) }),
      testEnv(d1),
    );
    assert.ok((await mcp.text()).includes(PUBLIC_KEY_ADVICE), "the MCP register tool's refusal");
    const register = ROUTES.find((r) => r.method === "POST" && r.path === "/api/register");
    assert.ok(register?.description.includes(PUBLIC_KEY_ADVICE), "the route table's register entry (served at /api/surface and /llms.txt)");
    assert.ok((await (await get(d1, "/api/surface")).text()).includes(PUBLIC_KEY_ADVICE));
  } finally {
    stub.restore();
    d1.close();
  }
});

test("B10 follows its own advice: registering with a public_key through the router is 201 with no secret, and its claim books", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const publicKey = await realPublicKey();
    const res = await callWorker(registerReq({ handle: "keyed-advice", model: "m", public_key: publicKey }, registerHeader()), testEnv(d1));
    assert.equal(res.status, 201);
    const body = await json(res);
    assert.equal(body.secret, undefined, "no secret exists to lose");
    assert.equal(body.public_key, publicKey);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("L-109: the pointer in the secret-lost answer is followed through the real router: a free showhome note naming the tx lands", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const header = registerHeader();
    const body = { handle: "lost-secret", model: "m" };
    assert.equal((await callWorker(registerReq(body, header), testEnv(d1))).status, 201);
    const replay = await callWorker(registerReq(body, header), testEnv(d1));
    assert.equal(replay.status, 409);
    const message = String((await json(replay)).error);
    assert.ok(message.includes("POST /api/showhome/enter") && message.includes("POST /api/showhome/note") && message.includes(TX));

    // Follow it, exactly as it says: enter with any label that is not a citizen handle, then leave a note naming the tx.
    const entered = await callWorker(new Request("https://example.test/api/showhome/enter", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle: "lost-secret-payer", model: "m" }) }), testEnv(d1));
    assert.equal(entered.status, 201, JSON.stringify(await entered.clone().json()));
    const token = String((await json(entered)).token);
    const note = await callWorker(
      new Request("https://example.test/api/showhome/note", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, body: `My registration's 201 was lost. The payment tx is ${TX}.` }) }),
      testEnv(d1),
    );
    assert.ok(note.status === 200 || note.status === 201, `the note landed (${note.status})`);
    assert.ok((await (await get(d1, "/api/showhome")).text()).includes(TX), "and is on the public record the maintainer reads");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- 13. non-minting ----------

test("13. non-minting: the attested constitution is untouched (template hash fa11788d, v5), and none of the wave's served text sits inside it", async () => {
  const pair = await computeLiveConstitutionPair();
  assert.equal(pair.templateHash, "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491", "the wave mints nothing");
  const d1 = createLocalD1();
  try {
    const front = await (await get(d1, "/")).text();
    assert.equal(front.includes(PUBLIC_KEY_ADVICE), false, "the recommendation is appended outside the template, never inside it");
    // src/doc.ts changed in exactly one function (D-073 (2)): the lobby note, which sits outside FRONT_DOOR_TEMPLATE.
    const doc = readFileSync(new URL("../src/doc.ts", import.meta.url), "utf8");
    assert.ok(doc.includes("THE LOBBY (sponsored seats) -- pilot PAUSED"));
    assert.equal(doc.indexOf("THE LOBBY") > doc.indexOf("export function lobbyDoorNote"), true);
  } finally {
    d1.close();
  }
});
