// B2b (docs/BRIEF-X402-SETTLE-HONESTY.md): the three registration scripts on an
// unknown outcome -- a signed request whose fetch REJECTS, and a second-leg 502
// (the server's unknown-outcome answer).
//
// The scripts' CLI paths read the operator's payer wallet (a Ben-custody
// *.local.* file) before they reach the signed leg, so they are never run here.
// What IS run is the one helper every script's signed leg goes through
// (register-maintainer.mjs sendSignedPayment), with an injected fetch and
// printer; a wiring test then pins that all three scripts call it and carry
// none of the old re-run advice. The warning is asserted POSITIVELY, word for
// word: a test that only asserted the absence of "safe to" would pass with the
// warning deleted.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAuthorization, sendSignedPayment, refusedLine } from "../scripts/register-maintainer.mjs";

// The hub's words (brief B2b), typed here rather than imported.
const WARNING =
  "Outcome unknown: the payment may have settled. Do not sign again until the original authorisation's outcome has been reconciled on-chain: after validBefore, EIP-3009 authorizationState(from, nonce) on Base USDC reads true if it was executed. Missing treasury or citizen records do not prove that no payment occurred.";

const PAYER = "0xC176771BB508abb2B2eC8D727D97FE8a68B63Cd9";
const REQS = {
  scheme: "exact",
  network: "base",
  maxAmountRequired: "1000000",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0xD9E17995352EF13F9Ba467e2F36C7614A45e7011",
  resource: "https://commonhold.randommonicle.workers.dev/api/register",
  description: "Register one citizen of Commonhold.",
  mimeType: "application/json",
  maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2" },
};

// Never throws: a helper that throws comes back as outcome "threw: <message>",
// so a change that lets it throw fails the caller's assertion, not the test.
async function send(fetchImpl: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<Response>) {
  const authorization = buildAuthorization(PAYER, REQS, Date.UTC(2026, 8, 28, 12, 0, 0));
  const printed: string[] = [];
  let result: { outcome: string; response?: Response; json?: unknown };
  try {
    result = await sendSignedPayment("https://example.test/api/register", '{"handle":"h","model":"m"}', "SIGNED-HEADER", authorization, {
      fetchImpl,
      printError: (line: unknown) => printed.push(String(line)),
    });
  } catch (e) {
    result = { outcome: `threw: ${(e as Error)?.message ?? e}` };
  }
  return { authorization, result, out: printed.join("\n") };
}
const jsonAnswer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function assertUnknownReport(out: string, authorization: { from: string; nonce: string; validBefore: string }, label: string) {
  assert.ok(out.includes(WARNING), `${label}: the warning, verbatim:\n${out}`);
  assert.ok(out.includes(`from:        ${authorization.from}`), `${label}: the authorisation's from`);
  assert.ok(out.includes(`nonce:       ${authorization.nonce}`), `${label}: its nonce`);
  assert.ok(out.includes(`validBefore: ${authorization.validBefore} (2026-09-28T12:05:00.000Z)`), `${label}: its validBefore, with the time it names`);
  assert.doesNotMatch(out, /safe to/i, `${label}: nothing calls a re-run safe`);
}

test("B2b: a signed request whose fetch REJECTS prints the authorisation's from, nonce and validBefore and the warning, returns unknown, and never calls a re-run safe", async () => {
  const { authorization, result, out } = await send(async () => {
    throw new TypeError("fetch failed: other side closed");
  });
  assert.equal(result.outcome, "unknown");
  assert.match(out, /errored in transit: fetch failed: other side closed/);
  assertUnknownReport(out, authorization, "rejected fetch");
});

test("B2b: a second-leg 502 (the server's unknown-outcome answer) prints the server's own words, then the same identifiers and warning, and returns unknown", async () => {
  const serverSays = "The facilitator has not yet settled this payment (settlement_pending): it may still land on-chain. Whether the money moved is unknown until the chain is checked; do not sign again.";
  const { authorization, result, out } = await send(async () => new Response(JSON.stringify({ error: serverSays }), { status: 502, headers: { "content-type": "application/json" } }));
  assert.equal(result.outcome, "unknown");
  assert.ok(out.includes(serverSays), "the server's body is shown");
  assertUnknownReport(out, authorization, "second-leg 502");
});

test("F1 (review round 1): EVERY 5xx on the signed request is an unknown outcome -- a 500 when a write fails after the settlement names the tx and leaves no treasury row -- printed with the identifiers and the warning", async () => {
  for (const [status, error] of [
    [500, "Your $1 payment settled (tx 0xabc) but registration then failed: handle 'h' is taken."],
    [500, "Internal error. The society apologizes."],
    [503, "upstream unavailable"],
    [504, "gateway timeout"],
  ] as const) {
    const { authorization, result, out } = await send(jsonAnswer(status, { error }));
    assert.equal(result.outcome, "unknown", `HTTP ${status}: unknown`);
    assert.ok(out.includes(`The server answered the signed request with HTTP ${status}:`), `HTTP ${status}: the status is named`);
    assert.ok(out.includes(error), `HTTP ${status}: the server's own words are shown`);
    assertUnknownReport(out, authorization, `HTTP ${status}`);
  }
});

test("F2 (review round 1): a signed request whose answer BODY cannot be read (the headers arrived, the body failed) is an unknown outcome, whatever the status", async () => {
  for (const status of [502, 201]) {
    const { authorization, result, out } = await send(async () => new Response(new ReadableStream({ start: (c) => c.error(new Error("body stream failed")) }), { status }));
    assert.equal(result.outcome, "unknown", `HTTP ${status} with an unreadable body: unknown, never a throw`);
    assert.ok(out.includes(`The server's answer to the signed request (HTTP ${status}) could not be read: body stream failed.`), `HTTP ${status}: says the answer could not be read:\n${out}`);
    assertUnknownReport(out, authorization, `HTTP ${status}, unreadable body`);
  }
});

test("F1: a status that is neither a 201 nor a 4xx (a 200, a 202, a 302) is no answer this door gives, so it is an unknown outcome too", async () => {
  for (const status of [200, 202, 302]) {
    const { authorization, result, out } = await send(jsonAnswer(status, { note: "not this door's answer" }));
    assert.equal(result.outcome, "unknown", `HTTP ${status}: unknown`);
    assertUnknownReport(out, authorization, `HTTP ${status}`);
  }
});

test("B2b positive control: a 201 and a 402 come back as answered for the script's own handling and print nothing, and the helper sends exactly the signed request it was given", async () => {
  for (const status of [201, 402]) {
    let seen: { url: string; init: { method: string; headers: Record<string, string>; body: string } } | null = null;
    const { result, out } = await send(async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ ok: status }), { status, headers: { "content-type": "application/json" } });
    });
    assert.equal(result.outcome, "answered", `HTTP ${status}`);
    if (result.outcome !== "answered") return;
    assert.equal(result.response.status, status);
    assert.deepEqual(result.json, { ok: status });
    assert.equal(out, "", `HTTP ${status}: nothing printed, so the lines above belong to the unknown-outcome path`);
    assert.equal(seen!.url, "https://example.test/api/register");
    assert.equal(seen!.init.method, "POST");
    assert.equal(seen!.init.headers["X-PAYMENT"], "SIGNED-HEADER");
    assert.equal(seen!.init.body, '{"handle":"h","model":"m"}');
  }
});

test("F1: a 4xx on the signed request stays a refusal -- answered, nothing printed -- and the scripts' shared refusal line says why no money moved", async () => {
  for (const status of [400, 403, 409, 429]) {
    const { result, out } = await send(jsonAnswer(status, { error: "refused" }));
    assert.equal(result.outcome, "answered", `HTTP ${status}: a refusal, for the script's own handling`);
    assert.equal(out, "", `HTTP ${status}: no unknown-outcome report`);
  }
  assert.equal(
    refusedLine(409),
    "Registration was refused: HTTP 409. A 4xx on the signed request is a refusal: the server runs its checks again before it settles, and a 402 is the facilitator's own refusal of the payment, so by their account no money moved.",
  );
});

test("B2b wiring: register-maintainer.mjs, lobby-sponsor.mjs and keyauth-ride.mjs each send their signed request through sendSignedPayment, stop on its unknown outcome, print the shared refusal line for a 4xx, send no X-PAYMENT request of their own, and carry none of the old re-run advice", () => {
  const read = (name: string) => readFileSync(join(import.meta.dirname, "..", "scripts", name), "utf8").replace(/\r\n/g, "\n");
  const CALL = "const sent = await sendSignedPayment(target, body, paymentHeader, authorization);\n  if (sent.outcome === \"unknown\") {\n    process.exitCode = 1;\n    return;\n  }";
  const REFUSAL = "  if (second.status !== 201) {\n    // Only a 4xx reaches here: sendSignedPayment treats every other status as an unknown outcome.\n    console.error(refusedLine(second.status));";
  for (const name of ["register-maintainer.mjs", "lobby-sponsor.mjs", "keyauth-ride.mjs"]) {
    const src = read(name);
    assert.equal(src.split(CALL).length - 1, 1, `${name}: the signed leg goes through sendSignedPayment exactly once and stops on unknown`);
    assert.equal(src.split(REFUSAL).length - 1, 1, `${name}: the one non-201 branch left prints the shared refusal line`);
    // The helper's own fetch is the only request that carries the signed header.
    const own = src.split('"X-PAYMENT": paymentHeader').length - 1;
    assert.equal(own, name === "register-maintainer.mjs" ? 1 : 0, `${name}: no X-PAYMENT request outside the helper`);
    if (name !== "register-maintainer.mjs") assert.match(src, /\n  sendSignedPayment,\n  refusedLine,\n\} from "\.\/register-maintainer\.mjs";/, `${name}: imports the shared helper and refusal line`);
    assert.doesNotMatch(src, /safe to just run/i, `${name}: the false "safe to just run this script again"`);
    assert.doesNotMatch(src, /for this handle before any re-run/, `${name}: the old treasury/citizens re-run check`);
    assert.doesNotMatch(src, /re-run only if no keyholder citizen/, `${name}: the old keyholder re-run check`);
    // Review round 1 (F1): no error print may send the operator to a record as proof of anything.
    for (const line of src.split("\n").filter((l) => l.includes("console.error("))) {
      assert.doesNotMatch(line, /GET \/treasury|GET \/api\/citizens|GET \/api\/official/, `${name}: an error print points at a record as proof: ${line.trim()}`);
    }
  }
});
