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
import { buildAuthorization, sendSignedPayment } from "../scripts/register-maintainer.mjs";

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

async function send(fetchImpl: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<Response>) {
  const authorization = buildAuthorization(PAYER, REQS, Date.UTC(2026, 8, 28, 12, 0, 0));
  const printed: string[] = [];
  const result = await sendSignedPayment("https://example.test/api/register", '{"handle":"h","model":"m"}', "SIGNED-HEADER", authorization, {
    fetchImpl,
    printError: (line: unknown) => printed.push(String(line)),
  });
  return { authorization, result, out: printed.join("\n") };
}

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

test("B2b wiring: register-maintainer.mjs, lobby-sponsor.mjs and keyauth-ride.mjs each send their signed request through sendSignedPayment, stop on its unknown outcome, send no X-PAYMENT request of their own, and carry none of the old re-run advice", () => {
  const read = (name: string) => readFileSync(join(import.meta.dirname, "..", "scripts", name), "utf8").replace(/\r\n/g, "\n");
  const CALL = "const sent = await sendSignedPayment(target, body, paymentHeader, authorization);\n  if (sent.outcome === \"unknown\") {\n    process.exitCode = 1;\n    return;\n  }";
  for (const name of ["register-maintainer.mjs", "lobby-sponsor.mjs", "keyauth-ride.mjs"]) {
    const src = read(name);
    assert.equal(src.split(CALL).length - 1, 1, `${name}: the signed leg goes through sendSignedPayment exactly once and stops on unknown`);
    // The helper's own fetch is the only request that carries the signed header.
    const own = src.split('"X-PAYMENT": paymentHeader').length - 1;
    assert.equal(own, name === "register-maintainer.mjs" ? 1 : 0, `${name}: no X-PAYMENT request outside the helper`);
    if (name !== "register-maintainer.mjs") assert.match(src, /\n  sendSignedPayment,\n\} from "\.\/register-maintainer\.mjs";/, `${name}: imports the shared helper`);
    assert.doesNotMatch(src, /safe to just run/i, `${name}: the false "safe to just run this script again"`);
    assert.doesNotMatch(src, /for this handle before any re-run/, `${name}: the old treasury/citizens re-run check`);
    assert.doesNotMatch(src, /re-run only if no keyholder citizen/, `${name}: the old keyholder re-run check`);
  }
});
