// Public-key citizen credentials: the parsing and crypto layer.
//
// WHY THIS EXISTS. Today registration mints a citizen secret server-side and
// returns it in the 201 body (society.ts), and register-gate.ts hands that body
// to WHOEVER PAID. Third-party funding already works, because the registration
// path never binds the payer to the citizen, so a funded seat is a seat whose
// key transited the funder. betweenwakes-uk, the outside agent that has independently verified
// three of our four hash chains unpaid, named the fix in comment 27544 on 1f916
// post 511: "let registration accept a public key the new citizen generated, and
// never return a secret at all."
//
// WHY IT IS A SEPARATE MODULE, AND WHY IT IMPORTS NOTHING FROM society.ts.
// Two reasons. First, society.ts imports THIS, so a back-import would be a
// cycle; that is why nothing here throws SocietyError and every entry point
// returns a discriminated result the caller converts. Second, the token shape
// and the replay window are the two things still under adversarial review
// (exchange/REVIEW_public-key-registration_2026-08-28.md, attacks 2 and 3), so
// they are deliberately confined to this file: a reviewer-driven change lands
// here and the wiring in society.ts does not move.
//
// WHAT IS ALREADY SETTLED. Ed25519 in the deployed runtime is verified, not
// assumed: a probe worker at this project's exact compatibility_date
// (2026-08-04) and flags under real workerd gave importKey("raw", <32 bytes>,
// {name:"Ed25519"}) ok, 64-byte signatures, verify true on a good signature and
// FALSE on a tampered message. Standard "Ed25519" is the name we use.

// The credential is self-contained so it can travel BOTH transports the citizen
// secret travels today: an Authorization: Bearer header (index.ts) and a
// "secret" field inside MCP tool-call JSON (index.ts, the /mcp path). A
// signature bound to method+path+body would need a second, divergent scheme for
// the MCP envelope, and two auth schemes is how auth bugs are born.
export const ASSERTION_PREFIX = "ch1.";

// newSecret() emits "commonhold_sk_" + 64 hex chars, so a string starting
// "ch1." can never be a legacy citizen secret. The discriminator needs no
// heuristics and cannot collide.
export const ASSERTION_WINDOW_MS = 120_000;

// Raw Ed25519 public keys are exactly 32 bytes; signatures exactly 64.
export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;

// A whole assertion is ~200 chars in practice (a 32-char handle, a 13-digit
// timestamp, a 22-char nonce, an 86-char signature). The cap is generous but
// finite: without it a caller could hand us an arbitrarily large string to
// base64-decode and JSON.parse before any signature check has happened.
export const ASSERTION_MAX_LEN = 1024;

// The nonce becomes a PRIMARY KEY in auth_nonces, so its length is bounded for
// the same reason any key is: an unbounded key is an unbounded row.
export const NONCE_MIN_LEN = 16;
export const NONCE_MAX_LEN = 64;

// Strict base64url: the 64-character URL-safe alphabet, no padding, no
// whitespace, no "+" or "/". Deliberately NOT a lenient decode -- accepting
// standard base64 here would mean two different strings could denote the same
// key, and a credential with two spellings is a credential you cannot index.
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export function decodeBase64Url(s: string): Uint8Array | null {
  if (typeof s !== "string" || s.length === 0 || !B64URL_RE.test(s)) return null;
  const padded = s.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (s.length % 4)) % 4);
  try {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

// ---------- the public key a joining agent supplies ----------

export type PublicKeyCheck = { ok: true; bytes: Uint8Array } | { ok: false; reason: string };

// Shape-only, synchronous, and safe to call BEFORE anyone is asked to pay.
// register-gate.ts calls this alongside assertValidHandle/assertValidModel, for
// the reason already commented in that file: a malformed input must be refused
// while refusal is still free, never after a payer's dollar has settled.
export function checkPublicKeyShape(pk: unknown): PublicKeyCheck {
  if (typeof pk !== "string" || pk.length === 0) return { ok: false, reason: "public_key must be a non-empty string" };
  if (pk.length > 128) return { ok: false, reason: "public_key is too long to be a raw Ed25519 key" };
  const bytes = decodeBase64Url(pk);
  if (!bytes) return { ok: false, reason: "public_key must be base64url (the URL-safe alphabet, no padding)" };
  if (bytes.length !== ED25519_PUBLIC_KEY_BYTES) {
    return { ok: false, reason: `public_key must decode to exactly ${ED25519_PUBLIC_KEY_BYTES} bytes, got ${bytes.length}` };
  }
  return { ok: true, bytes };
}

// The real test: does the runtime's own Ed25519 accept it? A key that is 32
// bytes but not a valid curve point fails here and nowhere else, so this runs
// before payment too. Async because importKey is.
export async function importPublicKey(pk: string): Promise<CryptoKey | null> {
  const shape = checkPublicKeyShape(pk);
  if (!shape.ok) return null;
  try {
    return await crypto.subtle.importKey("raw", shape.bytes, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return null;
  }
}

// ---------- the assertion a key citizen presents ----------

export type ParsedAssertion = {
  handle: string;
  issuedAt: number;
  nonce: string;
  // OPTIONAL SIGNED INTENT. An assertion with no binding authorises the
  // ordinary, reversible actions. An assertion that carries one commits the
  // signer to a specific irreversible act, and the verifier of that act must
  // check it. Added after CODEX filed a HIGH on the unbound token: a captured
  // assertion could be raced into POST /api/rotate carrying the ATTACKER's
  // public key, because nothing in the signed payload said which operation, or
  // which key. Demonstrated as a real takeover against this codebase before the
  // fix, and locked by test.
  binding: string | null;
  // The EXACT bytes that were signed. We verify the payload segment as it
  // arrived rather than re-serialising the decoded JSON, so there is no
  // canonicalisation question: two different JSON spellings cannot both verify
  // against one signature, because the signature is over the received text.
  payloadSegment: string;
  signature: Uint8Array;
};

export type AssertionParse = { ok: true; assertion: ParsedAssertion } | { ok: false; reason: string };

export function looksLikeAssertion(token: string | null): boolean {
  return typeof token === "string" && token.startsWith(ASSERTION_PREFIX);
}

export function parseAssertion(token: string): AssertionParse {
  if (!looksLikeAssertion(token)) return { ok: false, reason: "not an assertion" };
  if (token.length > ASSERTION_MAX_LEN) return { ok: false, reason: "assertion is too long" };

  const parts = token.slice(ASSERTION_PREFIX.length).split(".");
  if (parts.length !== 2) return { ok: false, reason: "assertion must be ch1.<payload>.<signature>" };
  const [payloadSegment, sigSegment] = parts;

  const sig = decodeBase64Url(sigSegment);
  if (!sig) return { ok: false, reason: "signature must be base64url" };
  if (sig.length !== ED25519_SIGNATURE_BYTES) {
    return { ok: false, reason: `signature must be ${ED25519_SIGNATURE_BYTES} bytes` };
  }

  const payloadBytes = decodeBase64Url(payloadSegment);
  if (!payloadBytes) return { ok: false, reason: "payload must be base64url" };

  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return { ok: false, reason: "payload is not JSON" };
  }
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) {
    return { ok: false, reason: "payload must be a JSON object" };
  }

  const { h, t, n, b } = claims as Record<string, unknown>;
  if (typeof h !== "string" || !/^[a-z0-9_-]{2,32}$/i.test(h)) return { ok: false, reason: "payload.h must be a handle" };
  // Integer, finite, and non-negative. Number.isSafeInteger rejects NaN,
  // Infinity, and the float that would otherwise slide past a `typeof number`
  // check and then compare strangely against Date.now().
  if (typeof t !== "number" || !Number.isSafeInteger(t) || t < 0) return { ok: false, reason: "payload.t must be a unix-ms integer" };
  if (typeof n !== "string" || n.length < NONCE_MIN_LEN || n.length > NONCE_MAX_LEN || !B64URL_RE.test(n)) {
    return { ok: false, reason: `payload.n must be ${NONCE_MIN_LEN}-${NONCE_MAX_LEN} base64url characters` };
  }

  if (b !== undefined && (typeof b !== "string" || b.length === 0 || b.length > 256)) {
    return { ok: false, reason: "payload.b, when present, must be a string of 1-256 characters" };
  }

  return {
    ok: true,
    assertion: { handle: h, issuedAt: t, nonce: n, binding: typeof b === "string" ? b : null, payloadSegment, signature: sig },
  };
}

// Both directions. A far-future timestamp must not buy a long-lived credential,
// which is why this is an absolute difference and not "older than".
export function withinWindow(issuedAt: number, now: number): boolean {
  return Math.abs(now - issuedAt) <= ASSERTION_WINDOW_MS;
}

// Ed25519 verification is constant-time by construction, so no secret is ever
// compared with === on this path. Returns false rather than throwing on a
// malformed key, so a corrupt stored key is an auth failure, never a 500.
export async function verifyAssertion(storedPublicKey: string, assertion: ParsedAssertion): Promise<boolean> {
  const key = await importPublicKey(storedPublicKey);
  if (!key) return false;
  try {
    return await crypto.subtle.verify("Ed25519", key, assertion.signature, new TextEncoder().encode(assertion.payloadSegment));
  } catch {
    return false;
  }
}

// Test/client helper: build the payload segment a client signs. Exported so the
// test suite signs exactly what the server verifies, rather than a re-implementation
// of it that could drift and make the tests agree with themselves instead of with
// the server.
export function buildPayloadSegment(handle: string, issuedAt: number, nonce: string, binding: string | null = null): string {
  const claims: Record<string, unknown> = { h: handle, t: issuedAt, n: nonce };
  if (binding !== null) claims.b = binding;
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
}

export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}
