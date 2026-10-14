// The payer-trace parser against the template's REAL output (penny-three wave, hub ruling F1): src/register-gate.ts keeps its registration template inline and untouched, so the proof
// that the parser reads what it writes is to drive the real paid registration path (handleRegisterGate -> payAndSettle -> finishRegistration) over the real schema, take the treasury ledger
// row it wrote, and parse that row's description; then to read the same row back through GET /api/citizens' payer_trace. The facilitator is the only stub (as in register-gate-d1.test.ts).
//
// Run just this file: node --experimental-strip-types --test "test/penny-three-registration-d1.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1 } from "./helpers/local-d1.ts";
import { paymentHeaderFor } from "./helpers/x402-payload.ts";
import { registrationRowText } from "./helpers/registration-row.ts";
import { handleRegisterGate, parseRegistrationDescription } from "../src/register-gate.ts";
import { citizenDirectory, OPERATOR_WALLET, type Env } from "../src/society.ts";

const TREASURY_ADDRESS = "0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c9";
const FACILITATOR_URL = "https://facilitator.example.invalid";
// A settled payment as the facilitator reports it: a 20-byte payer and a 32-byte transaction hash (the stub in register-gate-d1.test.ts uses shorter placeholders).
const OUTSIDE_PAYER = "0xb54bb69b0d61b1f4083ec4d3992d84d85564d398";
const OPERATOR_PAYER_MIXED_CASE = "0x3F2950654EF9BF2D73805A77A07E4E14D5F74F16";
const TX_A = "0x" + "a1".repeat(32);
const TX_B = "0x" + "b2".repeat(32);

function stubFacilitator(payer: string, tx: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    const href = String(url);
    if (href === `${FACILITATOR_URL}/verify`) return new Response(JSON.stringify({ isValid: true }), { status: 200, headers: { "content-type": "application/json" } });
    if (href === `${FACILITATOR_URL}/settle`) return new Response(JSON.stringify({ success: true, payer, transaction: tx }), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error(`unexpected fetch in penny-three-registration-d1.test.ts: ${href}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const registerRequest = (handle: string, ip: string): Request =>
  new Request("https://example.test/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeaderFor(TREASURY_ADDRESS, "1000000"), "CF-Connecting-IP": ip },
    body: JSON.stringify({ handle, model: "test-model" }),
  });

test("T3 (real path): the ledger row a real paid registration writes parses to its payer, handle and tx, and reads back as the seat's payer_trace", async () => {
  const d1 = createLocalD1();
  const env = { DB: d1.DB, TREASURY_ADDRESS, FACILITATOR_URL, REGISTRATION_MODE: "open" } as unknown as Env;
  try {
    const registered: [string, string, string, string][] = [
      ["paid-by-outsider", OUTSIDE_PAYER, TX_A, "198.51.100.21"],
      ["paid-by-operator", OPERATOR_PAYER_MIXED_CASE, TX_B, "198.51.100.22"],
    ];
    for (const [handle, payer, tx, ip] of registered) {
      const restore = stubFacilitator(payer, tx);
      try {
        const res = await handleRegisterGate(registerRequest(handle, ip), env);
        assert.equal(res.status, 201, `registering ${handle}: ${await res.clone().text()}`);
      } finally {
        restore();
      }
    }
    const rows = d1.raw.prepare("SELECT description FROM ledger ORDER BY id ASC").all() as { description: string }[];
    assert.equal(rows.length, 2, "one treasury row per registration");
    for (const [i, [handle, payer, tx]] of registered.entries()) {
      const description = rows[i]!.description;
      // the real output is exactly the fixture text the other tests use, and the parser reads it
      assert.equal(description, registrationRowText(payer, handle, tx), "the real path writes the shape the fixtures assume");
      assert.deepEqual(parseRegistrationDescription(description), { payer, handle, tx });
    }
    // and the census serves it: the same two rows, through citizenDirectory's single ledger read
    const page: any = await citizenDirectory(env);
    const trace = (h: string) => page.citizens.find((c: any) => c.handle === h).payer_trace;
    assert.deepEqual(trace("paid-by-outsider"), { direct_payer: OUTSIDE_PAYER, direct_payer_is_operator_wallet: false, beyond_direct_payer: "not_checkable_by_us" });
    assert.deepEqual(trace("paid-by-operator"), { direct_payer: OPERATOR_PAYER_MIXED_CASE, direct_payer_is_operator_wallet: true, beyond_direct_payer: "not_checkable_by_us" });
    assert.equal(OPERATOR_WALLET, OPERATOR_PAYER_MIXED_CASE.toLowerCase());
  } finally {
    d1.close();
  }
});
