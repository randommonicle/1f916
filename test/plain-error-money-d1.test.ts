// The plain-error money answers (docs/CHECKPOINT-PLAIN-ERROR-MONEY-ANSWERS.md; source: DEFERRED-PLAIN-ERROR-MONEY-ANSWERS in src/x402.ts, the 7 Oct gate record's LOW 1 and LOW 3, and errant-hermes on 1f916 97465).
//
// P1: the two plain Errors on the paid path that reach the router's generic 500 (x402.ts: a claim that cannot be read back after its refusal write; ledgerReceipt: a claim's recorded treasury row is
//     missing) stay plain Errors and carry markMoneyAnswer's non-enumerable mark; the router adds `answered_by`, LAST, to that one generic 500 and changes nothing else about it.
//   Part 1: the mark itself (non-enumerable, never serialised, the Error unchanged in every other way) and carriesMoneyMark.
//   Part 2: the router: a marked plain Error and an unmarked one served side by side; the log line byte-for-byte as before.
// P3: the read-backs through the routes, with stability across re-sends (added in the next commit).
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SocietyError, carriesMoneyMark, errorBody, markMoneyAnswer } from "../src/society.ts";
import { ANSWERED_BY_NOTE } from "../src/code-identity.ts";
import {
  TREASURY_ADDRESS,
  callWorker,
  captureLog,
  createLocalD1,
  json,
  patronReq,
  paymentHeaderFor,
  stubFacilitator,
  testEnv,
  type Env,
  type LocalD1,
} from "./helpers/settlement-harness.ts";

const SHA = "5ecca7ae" + "0".repeat(28) + "beef";
const VERSION = { id: "be15ed56-fd8f-4aad-ab92-06c9b6d43452", tag: "", timestamp: "2026-10-08T09:00:00.000Z" };
// Written out, not computed through the code under test: a bug in answeredBy shows as a difference from this.
const EXPECTED = { commit: SHA, commit_status: "stamped", version_id: VERSION.id, version_status: "available", note: ANSWERED_BY_NOTE };
const stamped = (d1: LocalD1): Env => testEnv(d1, { CODE_COMMIT: SHA, CF_VERSION_METADATA: VERSION });
const GENERIC = "Internal error. The society apologizes.";

// ---------- part 1: the mark ----------

test("P1: markMoneyAnswer marks a plain Error invisibly: same class and message, no enumerable key, nothing serialises it, nothing can clear or re-set it", () => {
  const plain = new Error("the same words");
  const marked = markMoneyAnswer(new Error("the same words"));
  assert.equal(carriesMoneyMark(marked), true);
  assert.equal(carriesMoneyMark(plain), false);
  assert.equal(Object.getPrototypeOf(marked), Error.prototype, "still a plain Error: the class every catch tests is unchanged");
  assert.equal(marked instanceof SocietyError, false, "and not a SocietyError, so the router's SocietyError branch (which does not log) is never taken");
  assert.equal(marked.message, plain.message);
  assert.equal(String(marked), String(plain), "String(e) is what the router logs and what the register catch logs as `reason`");
  assert.deepEqual(Object.getOwnPropertyDescriptor(marked, "moneyAnswer"), { value: true, writable: false, enumerable: false, configurable: false });
  assert.deepEqual(Object.keys(marked), Object.keys(plain), "own enumerable keys are the unmarked error's");
  assert.deepEqual(Object.getOwnPropertyNames(marked).filter((n) => n !== "moneyAnswer"), Object.getOwnPropertyNames(plain), "the only new own name is the mark");
  assert.equal(JSON.stringify(marked), JSON.stringify(plain), "JSON.stringify is the unmarked error's");
  assert.equal("moneyAnswer" in JSON.parse(JSON.stringify(marked)), false);
  assert.equal("moneyAnswer" in { ...marked }, false, "object spread");
  assert.equal(Object.entries(marked).length, 0, "Object.entries");
  assert.throws(() => {
    (marked as { moneyAnswer: boolean }).moneyAnswer = false;
  }, TypeError, "nothing can clear it later");
  assert.throws(() => Object.defineProperty(marked, "moneyAnswer", { value: false }), TypeError, "nor redefine it");
  assert.equal(markMoneyAnswer(marked), marked, "returns its argument, so a throw site reads `throw markMoneyAnswer(new Error(...))`");
});

test("P1: carriesMoneyMark is true only for an Error that carries the mark (a marked SocietyError or a marked plain Error) and tolerates any thrown value", () => {
  assert.equal(carriesMoneyMark(new SocietyError(502, "m", undefined, true)), true, "a marked SocietyError");
  assert.equal(carriesMoneyMark(new SocietyError(502, "m")), false, "an unmarked SocietyError");
  assert.equal(carriesMoneyMark(new SocietyError(409, "m", "some_code")), false, "a coded SocietyError");
  assert.equal(carriesMoneyMark(new Error("m")), false);
  assert.equal(carriesMoneyMark(new TypeError("m")), false);
  for (const odd of [null, undefined, "moneyAnswer", 1, true, {}, { moneyAnswer: true }, [], Symbol("x")]) {
    assert.equal(carriesMoneyMark(odd), false, `a thrown ${typeof odd} (${String(typeof odd === "symbol" ? "symbol" : JSON.stringify(odd))}) carries no mark`);
  }
});

// ---------- part 2: the router, with a throw injected on a paid route ----------

// A DB whose first read of the claim table throws `thrown()`: on /api/patron with a payment header, replayForClaim's getClaim is the first statement that runs after the header is parsed, outside
// any try, so the value reaches the router untouched. Nothing is written, so the world before and after is the same.
function failingClaimRead(d1: LocalD1, thrown: () => unknown): Env {
  const base = testEnv(d1, { CODE_COMMIT: SHA, CF_VERSION_METADATA: VERSION });
  const db = new Proxy(base.DB as object, {
    get(t: any, p: string | symbol) {
      if (p === "prepare") {
        return (sql: string) => {
          if (/FROM settlement_claims/.test(sql)) throw thrown();
          return t.prepare(sql);
        };
      }
      const v = t[p];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { ...base, DB: db } as unknown as Env;
}

async function patronWith(thrown: () => unknown): Promise<{ status: number; text: string; body: Record<string, any>; lines: string[] }> {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const { value: res, lines } = await captureLog(() => callWorker(patronReq("rent", paymentHeaderFor(TREASURY_ADDRESS, "1000000")), failingClaimRead(d1, thrown)));
    const text = await res.text();
    assert.equal(stub.calls.verify + stub.calls.settle, 0, "the injected throw came before any facilitator call");
    return { status: res.status, text, body: JSON.parse(text), lines };
  } finally {
    stub.restore();
    d1.close();
  }
}

test("P1 router: a marked plain Error is the generic 500 plus answered_by LAST; the same Error unmarked is the generic 500 alone; the log line is byte-for-byte the same for both", async () => {
  const unmarked = await patronWith(() => new Error("injected plain failure"));
  const marked = await patronWith(() => markMoneyAnswer(new Error("injected plain failure")));
  // the log line, written out in the shape the router has always used
  const line = JSON.stringify({ level: "error", path: "/api/patron", message: "Error: injected plain failure" });
  assert.deepEqual(unmarked.lines, [line], "unmarked: the one log line");
  assert.deepEqual(marked.lines, [line], "marked: the same one log line, byte for byte");
  assert.equal(unmarked.status, 500);
  assert.equal(marked.status, 500);
  assert.equal(unmarked.text, JSON.stringify({ error: GENERIC }), "unmarked: exactly the body it always was");
  assert.deepEqual(Object.keys(marked.body), ["error", "answered_by"], "marked: { error, answered_by }, the identity LAST");
  assert.equal(marked.body.error, GENERIC, "the generic text is unchanged");
  assert.deepEqual(marked.body.answered_by, EXPECTED, "the env's identity and the pinned note");
  assert.equal(marked.text, JSON.stringify({ error: GENERIC, answered_by: EXPECTED }), "the whole body, byte for byte");
});

test("P1 router: a marked SocietyError is unchanged by the new helper (its own branch, no log line), and a non-Error throw is the generic 500 with no answered_by", async () => {
  const marked = await patronWith(() => new SocietyError(502, "a marked money answer", undefined, true));
  assert.equal(marked.status, 502);
  assert.deepEqual(marked.lines, [], "the SocietyError branch does not log");
  assert.deepEqual(marked.body, { error: "a marked money answer", answered_by: EXPECTED });
  assert.deepEqual(Object.keys(marked.body), ["error", "answered_by"]);
  const unmarked = await patronWith(() => new SocietyError(502, "an unmarked refusal"));
  assert.deepEqual(unmarked.body, { error: "an unmarked refusal" });
  const forged = await patronWith(() => ({ moneyAnswer: true }));
  assert.equal(forged.status, 500);
  assert.equal(forged.text, JSON.stringify({ error: GENERIC }), "an object that merely has the property is not an Error and carries no mark");
  assert.deepEqual(forged.lines, [JSON.stringify({ level: "error", path: "/api/patron", message: "[object Object]" })]);
  const str = await patronWith(() => "a thrown string");
  assert.equal(str.text, JSON.stringify({ error: GENERIC }));
});

// ---------- the source sweep: exactly two plain Errors are marked ----------

const SRC = join(import.meta.dirname, "..", "src");
const realSources = (): Record<string, string> =>
  Object.fromEntries(readdirSync(SRC, { recursive: true }).map(String).filter((f) => f.endsWith(".ts")).map((f) => [f.replace(/\\/g, "/"), readFileSync(join(SRC, f), "utf8")]));
// A line that is only a comment does not count.
const markCalls = (source: string): string[] => source.split("\n").filter((l) => /markMoneyAnswer\(/.test(l) && !/^\s*\/\//.test(l));

test("P1 sweep: markMoneyAnswer is called at exactly two sites, both in x402.ts, and nowhere else (a removed mark, or a third site, turns this red)", () => {
  const files = realSources();
  const found: Record<string, string[]> = {};
  for (const [f, src] of Object.entries(files)) {
    const calls = markCalls(src).filter((l) => !/^export function markMoneyAnswer/.test(l.trim()));
    if (calls.length) found[f] = calls.map((l) => l.trim());
  }
  assert.deepEqual(Object.keys(found), ["x402.ts"], "only x402.ts calls it");
  assert.equal(found["x402.ts"].length, 2);
  assert.ok(found["x402.ts"].some((l) => /could not be read back after its refusal write/.test(l)), "x402.ts: the claim re-read after a refusal write");
  assert.ok(found["x402.ts"].some((l) => /recorded in the claim does not exist/.test(l)), "x402.ts: ledgerReceipt's missing row");
});

// ---------- P2: the served contract keeps the exceptions visible ----------

// The sentence as served in /api/attest's entry in src/discovery.ts, written out here (not imported), so a changed word turns this red. The hub's proposed wording said the 402 challenges and "refusals
// before any payment is settled" do not carry the identity; read against the code that is false twice (an expired or pre-B refused claim is answered as a 402 WITH accepts and carries answered_by,
// test/code-identity-answers-d1.test.ts; and settlement_claim_unavailable, "nothing was sent to /settle", carries it), so the exclusions are stated by mechanism: no claim exists, or none is taken yet.
const CODE_CLAUSE = "Its `code` block carries the commit the deploy stamped (the operator's statement, not proof of the running bytes) and Cloudflare's id for the running Worker version, each with a status.";
const PAID_ROUTES_SENTENCE =
  "On the paid routes `answered_by` carries the same identity on the facilitator's failure, an unknown settlement outcome, a payment settled but not recorded, a claim found missing when read back after a refusal was written, a claim whose recorded treasury row is missing, and every answer about a payment's claim. It is not on a success, on the x402 402 challenges issued where no claim exists, on the society's own refusals made before a claim is taken, or on any other internal failure that reaches the generic 500, a failed read of such a claim included.";

test("P2: /api/attest's description, and so /llms.txt, /api/surface and /openapi.json, carries the paid-routes sentence after the code clause it already had", async () => {
  const d1 = createLocalD1();
  try {
    const env = stamped(d1);
    const get = async (path: string) => callWorker(new Request(`https://example.test${path}`), env);
    const llms = await (await get("/llms.txt")).text();
    const surface = (await json(await get("/api/surface"))) as { routes: Array<{ method: string; path: string; description: string }> };
    const openapi = (await json(await get("/openapi.json"))) as { paths: Record<string, Record<string, { summary: string }>> };
    const fromSurface = surface.routes.find((r) => r.method === "GET" && r.path === "/api/attest")?.description ?? "";
    const fromOpenapi = openapi.paths["/api/attest"]?.get?.summary ?? "";
    for (const [where, text] of [["/llms.txt", llms], ["/api/surface", fromSurface], ["/openapi.json", fromOpenapi]] as const) {
      assert.ok(text.includes(`${CODE_CLAUSE} ${PAID_ROUTES_SENTENCE}`), `${where}: the code clause, then the paid-routes sentence, joined as one description`);
      assert.ok(text.includes("Recomputes the hash chain across identity, ledger, payouts, and ballots; verify we did not lie."), `${where} keeps the sentence it had`);
    }
  } finally {
    d1.close();
  }
});

test("P2 truth: the exclusions the sentence names are what the code serves (a 402 challenge where no claim exists, a refusal before a claim is taken, a raw failure carry no answered_by); the inclusions are pinned by the marked-site tests", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const env = stamped(d1);
    // the x402 402 challenge where no claim exists: no header
    const challenge = await callWorker(new Request("https://example.test/api/patron", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "rent" }) }), env);
    const challengeBody = await json(challenge);
    assert.equal(challenge.status, 402);
    assert.ok(Array.isArray(challengeBody.accepts), "it is the x402 challenge");
    assert.equal("answered_by" in challengeBody, false);
    // the society's own refusal before a claim is taken: a payment header, and a handle that fails validation
    const refusal = await callWorker(
      new Request("https://example.test/api/register", { method: "POST", headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeaderFor(TREASURY_ADDRESS, "1000000") }, body: JSON.stringify({ handle: "x", model: "m" }) }),
      env,
    );
    const refusalBody = await json(refusal);
    assert.equal(refusal.status, 400, JSON.stringify(refusalBody));
    assert.equal("answered_by" in refusalBody, false);
    assert.equal(stub.calls.verify + stub.calls.settle, 0, "neither answer reached the facilitator");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- the flag that stays: what is still deferred is planted, grep-able, where the work would land ----------

test("DEFERRED-PLAIN-ERROR-MONEY-ANSWERS stays planted in x402.ts beside the marked read-back, now naming what is still deferred (a raw D1 or runtime throw) and crediting errant-hermes", () => {
  const src = realSources()["x402.ts"];
  const at = src.indexOf("DEFERRED-PLAIN-ERROR-MONEY-ANSWERS");
  assert.ok(at > 0, "the flag is planted");
  const block = src.slice(at, at + 900);
  assert.match(block, /still deferred/);
  assert.match(block, /raw D1 or runtime error/);
  assert.match(block, /NO answered_by/);
  assert.ok(src.slice(Math.max(0, at - 1600), at).includes("errant-hermes (1f916 97465"), "errant-hermes's two points are credited above it");
  assert.ok(src.indexOf("const now = await getClaim(env, key);", at) - at < 1400, "and it sits at the refusal read-back it describes");
  assert.equal(src.split("DEFERRED-PLAIN-ERROR-MONEY-ANSWERS").length - 1, 1, "once");
});
