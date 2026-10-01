// A real-SHAPED x402 "exact" payment header, for tests that stub the
// facilitator. Since the wallet-pin wave (A4, docs/BRIEF-SERVER-SIDE-WALLET-PIN.md)
// payAndSettle compares the payload's signed destination and amount with the
// requirements BEFORE /verify, so a test's X-PAYMENT carries the authorization
// the real client sends for that request (scripts/register-maintainer.mjs
// buildAuthorization + encodePaymentHeader): `to` is the requirements' payTo and
// `value` its maxAmountRequired, as a decimal string. The signature and nonce
// are placeholders: every caller stubs the facilitator, and signature
// verification stays the facilitator's job (A4's stated limit).

export const TEST_PAYER = "0x00000000000000000000000000000000000000fa";

// cents -> atomic USDC (6 decimals), the same ratio every route uses.
export function atomicFromCents(cents: number): string {
  return String(cents * 10_000);
}

// Every header this helper builds carries its OWN nonce unless a test passes one, because
// since the settlement-claim wave (docs/BRIEF-SETTLEMENT-REPLAY-GUARD.md) a signed
// authorisation's (from, nonce) is single-use: two payments in one test that shared the
// old constant zero nonce would be a replay, refused. A test that is ABOUT replay passes
// the nonce it means to reuse, or reuses the header it built.
let nonceCounter = 0;
export const freshNonce = (): string => "0x" + (++nonceCounter).toString(16).padStart(64, "0");

export function paymentHeaderFor(to: string, valueAtomic: string, authorizationOverrides: Record<string, unknown> = {}): string {
  const authorization = {
    from: TEST_PAYER,
    to,
    value: valueAtomic,
    validAfter: "0",
    validBefore: "9999999999",
    nonce: freshNonce(),
    ...authorizationOverrides,
  };
  return btoa(JSON.stringify({ x402Version: 1, scheme: "exact", network: "base", payload: { signature: "0x" + "11".repeat(65), authorization } }));
}
